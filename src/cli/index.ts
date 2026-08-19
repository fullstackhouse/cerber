#!/usr/bin/env node
import { Command } from "commander";
import { parsePrRef } from "../core/gh.js";
import { cerberHome, listArtifacts } from "../core/state.js";
import { reviewPr } from "../runner/review.js";
import { startServer } from "../server/index.js";

const program = new Command();

program
  .name("cerber")
  .description(
    "AI code-review cockpit. Claude reviews PRs into local artifacts; nothing reaches GitHub until you explicitly send it.",
  )
  .version("0.1.0");

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
