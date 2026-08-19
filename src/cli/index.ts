#!/usr/bin/env node
import { Command } from "commander";
import readline from "node:readline/promises";
import { artifactId, artifactKey } from "../core/artifact.js";
import { toMarkdown } from "../core/export.js";
import { parsePrRef, submitReview } from "../core/gh.js";
import { ReviewEvent, buildReviewPayload, eventForRecommendation } from "../core/send.js";
import { cerberHome, listArtifacts, loadArtifact, updateArtifactByKey } from "../core/state.js";
import { reviewPr } from "../runner/review.js";
import { startServer } from "../server/index.js";

const program = new Command();

program
  .name("cerber")
  .description(
    "AI code-review cockpit. Claude reviews PRs into local artifacts; nothing reaches GitHub until you explicitly send it.",
  )
  .version("0.2.0");

program
  .command("review")
  .description("Run an AI review of one or more PRs (local artifact only — no GitHub writes)")
  .argument("<pr...>", "PR URL, owner/repo#number, or number (with --repo)")
  .option("-R, --repo <owner/repo>", "repository for bare PR numbers")
  .option("-m, --model <model>", "Claude model override (e.g. sonnet, opus)")
  .action(async (prs: string[], opts: { repo?: string; model?: string }) => {
    let failures = 0;
    for (const input of prs) {
      const ref = parsePrRef(input, opts.repo);
      const label = `${ref.owner}/${ref.repo}#${ref.number}`;
      try {
        const artifact = await reviewPr(ref, {
          model: opts.model,
          onProgress: (m) => console.log(`[${label}] ${m}`),
        });
        const v = artifact.verdict;
        console.log(`\n✔ ${label} — ${artifact.pr.title}`);
        console.log(
          `  verdict: ${v?.recommendation ?? "?"} (confidence ${v?.confidence ?? "?"}%), ` +
            `${artifact.comments.length} draft comment(s)` +
            (artifact.run?.costUsd != null ? `, cost $${artifact.run.costUsd.toFixed(2)}` : ""),
        );
        console.log(`  artifact: ${cerberHome()}/reviews — view with: cerber serve`);
      } catch (err: unknown) {
        failures++;
        console.error(`\n✘ ${label} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (failures > 0) process.exitCode = 1;
  });

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
  .description("Start the local review cockpit (read-only in this version)")
  .option("-p, --port <port>", "port", "4820")
  .option("-H, --host <host>", "host to bind", "127.0.0.1")
  .action(async (opts: { port: string; host: string }) => {
    await startServer({ port: Number(opts.port), host: opts.host });
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
