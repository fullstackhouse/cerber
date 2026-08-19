#!/usr/bin/env node
import { Command } from "commander";
import readline from "node:readline/promises";
import { artifactId, artifactKey } from "../core/artifact.js";
import { toMarkdown } from "../core/export.js";
import { PrRef, parsePrRef, searchAwaitingMe, submitReview } from "../core/gh.js";
import { ReviewEvent, buildReviewPayload, eventForRecommendation } from "../core/send.js";
import { cerberHome, listArtifacts, loadArtifact, updateArtifactByKey } from "../core/state.js";
import { pool, reviewPr } from "../runner/review.js";
import { startServer } from "../server/index.js";

const program = new Command();

program
  .name("cerber")
  .description(
    "AI code-review cockpit. Claude reviews PRs into local artifacts; nothing reaches GitHub until you explicitly send it.",
  )
  .version("0.3.0");

program
  .command("review")
  .description("Run an AI review of one or more PRs (local artifact only — no GitHub writes)")
  .argument("[pr...]", "PR URL, owner/repo#number, or number (with --repo)")
  .option("-R, --repo <owner/repo>", "repository for bare PR numbers / to scope --awaiting-me")
  .option("-m, --model <model>", "Claude model override (e.g. sonnet, opus)")
  .option("-a, --awaiting-me", "discover and review all open PRs awaiting your review")
  .option("-P, --parallel <n>", "how many reviews to run concurrently", "3")
  .option("-f, --force", "re-review even if the artifact is up to date with the PR head")
  .action(
    async (
      prs: string[],
      opts: { repo?: string; model?: string; awaitingMe?: boolean; parallel: string; force?: boolean },
    ) => {
      let refs: PrRef[];
      if (opts.awaitingMe) {
        const found = await searchAwaitingMe(opts.repo);
        console.log(`Found ${found.length} open PR(s) awaiting your review${opts.repo ? ` in ${opts.repo}` : ""}.`);
        for (const f of found) {
          console.log(`  ${f.owner}/${f.repo}#${f.number} — ${f.title}`);
        }
        refs = found;
      } else {
        if (prs.length === 0) {
          console.error("Pass PR references, or use --awaiting-me.");
          process.exit(1);
        }
        refs = prs.map((input) => parsePrRef(input, opts.repo));
      }
      if (refs.length === 0) return;

      const parallel = Math.max(1, Number(opts.parallel) || 1);
      let failures = 0;
      let skips = 0;
      const rows: string[] = [];

      await pool(refs, parallel, async (ref) => {
        const label = `${ref.owner}/${ref.repo}#${ref.number}`;
        try {
          const { artifact, skipped } = await reviewPr(ref, {
            model: opts.model,
            force: opts.force,
            onProgress: (m) => console.log(`[${label}] ${m}`),
          });
          if (skipped) {
            skips++;
            return;
          }
          const v = artifact.verdict;
          rows.push(
            `✔ ${label.padEnd(40)} ${v ? `${v.recommendation} ${v.confidence}%` : "?"}`.padEnd(65) +
              `${artifact.comments.length} comment(s)` +
              (artifact.run?.costUsd != null ? `, $${artifact.run.costUsd.toFixed(2)}` : ""),
          );
        } catch (err: unknown) {
          failures++;
          rows.push(`✘ ${label} failed: ${err instanceof Error ? err.message : err}`);
        }
      });

      console.log("");
      for (const row of rows) console.log(row);
      if (skips > 0) console.log(`(${skips} already up to date — use --force to re-review)`);
      console.log(`\nArtifacts in ${cerberHome()}/reviews — view with: cerber serve`);
      if (failures > 0) process.exitCode = 1;
    },
  );

program
  .command("list")
  .description("List review artifacts and their statuses")
  .action(async () => {
    const artifacts = await listArtifacts();
    if (artifacts.length === 0) {
      console.log(`No reviews yet in ${cerberHome()}. Run: cerber review <pr-url>`);
      return;
    }
    for (const a of artifacts) {
      const v = a.verdict ? `${a.verdict.recommendation} ${a.verdict.confidence}%` : "-";
      console.log(
        `${a.status.padEnd(8)} ${a.id.padEnd(40)} ${v.padEnd(20)} ${a.pr.title}`,
      );
    }
  });

program
  .command("export")
  .description("Print a review as markdown (never touches GitHub)")
  .argument("<pr>", "PR URL, owner/repo#number, or number (with --repo)")
  .option("-R, --repo <owner/repo>", "repository for bare PR numbers")
  .action(async (input: string, opts: { repo?: string }) => {
    const ref = parsePrRef(input, opts.repo);
    const artifact = await loadArtifact(artifactId(ref));
    if (!artifact) {
      console.error(`No review found for ${artifactId(ref)}. Run: cerber review ${input}`);
      process.exit(1);
    }
    console.log(toMarkdown(artifact));
  });

program
  .command("send")
  .description("Send a reviewed artifact to GitHub as a PR review — the ONLY command that writes to GitHub")
  .argument("<pr>", "PR URL, owner/repo#number, or number (with --repo)")
  .option("-R, --repo <owner/repo>", "repository for bare PR numbers")
  .option(
    "-e, --event <event>",
    "APPROVE | COMMENT | REQUEST_CHANGES (default: the artifact's verdict)",
  )
  .option("-y, --yes", "skip the confirmation prompt")
  .action(async (input: string, opts: { repo?: string; event?: string; yes?: boolean }) => {
    const ref = parsePrRef(input, opts.repo);
    const id = artifactId(ref);
    const artifact = await loadArtifact(id);
    if (!artifact) {
      console.error(`No review found for ${id}. Run: cerber review ${input}`);
      process.exit(1);
    }
    if (artifact.sent) {
      console.error(`Already sent at ${artifact.sent.at}${artifact.sent.url ? ` — ${artifact.sent.url}` : ""}`);
      process.exit(1);
    }

    const event = (
      opts.event ??
      (artifact.verdict ? eventForRecommendation(artifact.verdict.recommendation) : "COMMENT")
    ).toUpperCase() as ReviewEvent;
    if (!["APPROVE", "COMMENT", "REQUEST_CHANGES"].includes(event)) {
      console.error(`Invalid event: ${event}`);
      process.exit(1);
    }

    const payload = buildReviewPayload(artifact, event);
    console.log(`About to send to ${artifact.pr.url}:`);
    console.log(`  event: ${event}`);
    console.log(`  inline comments: ${payload.comments.length}`);
    if (payload.folded.length > 0) {
      console.log(`  comments folded into body (no diff anchor): ${payload.folded.length}`);
    }
    console.log(`  body: ${payload.body.length} chars\n`);

    if (!opts.yes) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question("Send this review to GitHub? [y/N] ");
      rl.close();
      if (answer.trim().toLowerCase() !== "y") {
        console.log("Aborted — nothing was sent.");
        return;
      }
    }

    const { url } = await submitReview(ref, {
      event: payload.event,
      body: payload.body,
      comments: payload.comments,
    });
    await updateArtifactByKey(artifactKey(id), (a) => ({
      ...a,
      status: "sent" as const,
      sent: { at: new Date().toISOString(), event, url },
    }));
    console.log(`✔ Review sent${url ? `: ${url}` : "."}`);
  });

program
  .command("serve")
  .description("Start the local review cockpit")
  .option("-p, --port <port>", "port", "4820")
  .option("-H, --host <host>", "host to bind", "127.0.0.1")
  .action(async (opts: { port: string; host: string }) => {
    await startServer({ port: Number(opts.port), host: opts.host });
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
