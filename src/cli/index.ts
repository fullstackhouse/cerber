#!/usr/bin/env node
import { Command } from "commander";
import readline from "node:readline/promises";
import { artifactId, artifactKey } from "../core/artifact.js";
import { listCheckouts, removeCheckout } from "../core/checkout.js";
import { toMarkdown } from "../core/export.js";
import { configPath, loadConfig, saveConfig } from "../core/config.js";
import { TrustRuleError, describeRule, explainRule, parseTrustRule } from "../core/trust.js";
import { PrRef, parsePrRef, searchAwaitingMe, submitReview } from "../core/gh.js";
import { ReviewEvent, buildReviewPayload, computeCalibration, eventForRecommendation } from "../core/send.js";
import {
  cerberHome,
  listArtifacts,
  loadArtifact,
  readAutoSendLog,
  updateArtifactByKey,
} from "../core/state.js";
import { pool, reviewPr } from "../runner/review.js";
import { startDaemon } from "../server/daemon.js";
import { startServer } from "../server/index.js";

const program = new Command();

program
  .name("cerber")
  .description(
    "AI code-review cockpit. Claude reviews PRs into local artifacts; nothing reaches GitHub until you explicitly send it.",
  )
  .version("0.5.0");

program
  .command("review")
  .description("Run an AI review of one or more PRs (local artifact only — no GitHub writes)")
  .argument("[pr...]", "PR URL, owner/repo#number, or number (with --repo)")
  .option("-R, --repo <owner/repo>", "repository for bare PR numbers / to scope --awaiting-me")
  .option("-m, --model <model>", "Claude model override (e.g. sonnet, opus)")
  .option("-a, --awaiting-me", "discover and review all open PRs awaiting your review")
  .option("-P, --parallel <n>", "how many reviews to run concurrently", "3")
  .option("-f, --force", "re-review even if the artifact is up to date with the PR head")
  .option(
    "--no-source",
    "review the diff alone: skip the local checkout of the PR head. Faster and cheaper, but the AI cannot see past the changed lines",
  )
  .option(
    "-t, --trust",
    "let the review run commands in the checkout (tests, typecheck, git log) whatever the trust config says",
  )
  .option("--no-trust", "keep the review read-only even if a trust rule matches")
  .action(
    async (
      prs: string[],
      opts: {
        repo?: string;
        model?: string;
        awaitingMe?: boolean;
        parallel: string;
        force?: boolean;
        source: boolean;
        trust?: boolean;
      },
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
            withSource: opts.source,
            trust: opts.trust,
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
              (artifact.run?.costUsd != null ? `, ≈$${artifact.run.costUsd.toFixed(2)}` : ""),
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
      if (rows.some((r) => r.includes("≈$"))) {
        console.log(
          "(≈$ is what the tokens would cost at API rates — on a Claude subscription they draw on your usage limits, not your card.)",
        );
      }
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
      commitId: payload.commitId,
    });
    await updateArtifactByKey(artifactKey(id), (a) => ({
      ...a,
      status: "sent" as const,
      sent: { at: new Date().toISOString(), event, url, auto: false },
      calibration: computeCalibration(a, event),
    }));
    console.log(`✔ Review sent${url ? `: ${url}` : "."}`);
  });

program
  .command("trust")
  .description(
    "Show, add, or remove the people whose PRs a review may run (~/.cerber/config.json)",
  )
  .argument(
    "[pattern]",
    "@org/*, @org/team, @login, or !pattern to deny — omit to list what is trusted today",
  )
  .option("-d, --delete", "remove this rule instead of adding it")
  .action(async (pattern: string | undefined, opts: { delete?: boolean }) => {
    const config = await loadConfig();

    if (pattern) {
      let rule;
      try {
        rule = parseTrustRule(pattern);
      } catch (err: unknown) {
        console.error(err instanceof TrustRuleError ? err.message : String(err));
        process.exit(1);
      }
      if (!rule) {
        console.error(`Not a trust rule: "${pattern}"`);
        process.exit(1);
      }
      const canonical = describeRule(rule);
      const without = config.trust.filter((line) => {
        const parsed = parseTrustRule(line);
        return !parsed || describeRule(parsed) !== canonical;
      });
      if (opts.delete) {
        if (without.length === config.trust.length) {
          console.error(`Not in the trust list: ${canonical}`);
          process.exit(1);
        }
        await saveConfig({ ...config, trust: without });
        console.log(`Removed ${canonical}. Those PRs are reviewed read-only again.`);
        return;
      }
      await saveConfig({ ...config, trust: [...without, canonical] });
      console.log(`Trusted: ${explainRule(rule)}\n  → ${configPath()}`);
      console.log("Reviews of matching PRs may run tests, typechecks and git commands in the checkout.");
      return;
    }

    if (config.trust.length === 0) {
      console.log(
        `Nothing is trusted: every review reads the checkout and runs nothing.\n` +
          `Trust people — never a repo, since anyone can open a PR against one:\n` +
          `  cerber trust @your-org/*         # everyone in the org\n` +
          `  cerber trust @your-org/devs      # one GitHub team\n` +
          `  cerber trust @teammate           # one person\n` +
          `Rules live in ${configPath()}, and in the cockpit under Settings.`,
      );
      return;
    }

    console.log(`Trusted people (${configPath()}):`);
    for (const line of config.trust) {
      const rule = parseTrustRule(line);
      if (rule) console.log(`  ${describeRule(rule).padEnd(28)} ${explainRule(rule)}`);
    }
    console.log(
      "\nEveryone else's PRs are reviewed read-only. Remove one with: cerber trust <pattern> --delete",
    );
  });

program
  .command("prune")
  .description("Delete cached source checkouts in ~/.cerber/src (they re-fetch on the next --with-source review)")
  .option("--all", "delete every checkout, including ones for reviews still awaiting you")
  .action(async (opts: { all?: boolean }) => {
    const checkouts = await listCheckouts();
    if (checkouts.length === 0) {
      console.log(`No source checkouts in ${cerberHome()}/src.`);
      return;
    }
    const artifacts = new Map((await listArtifacts()).map((a) => [a.id, a]));
    const mb = (bytes: number) => {
      const value = bytes / 1024 / 1024;
      return `${value.toFixed(value < 10 ? 1 : 0)} MB`;
    };

    let freed = 0;
    let kept = 0;
    for (const checkout of checkouts) {
      const artifact = artifacts.get(checkout.id);
      // A review you have not sent yet is still live work — its checkout makes
      // the next re-review cheap, so only --all takes it.
      const done = !artifact || artifact.sent != null || artifact.pr.state !== "OPEN";
      if (!opts.all && !done) {
        kept++;
        continue;
      }
      await removeCheckout(checkout.dir);
      freed += checkout.bytes;
      console.log(`removed ${checkout.id.padEnd(40)} ${mb(checkout.bytes)}`);
    }
    console.log(`\nFreed ${mb(freed)}${kept > 0 ? `; kept ${kept} for open reviews (--all removes them too)` : ""}.`);
  });

program
  .command("stats")
  .description("How well-calibrated the AI reviews are: verdict agreement and comment survival by confidence")
  .action(async () => {
    const artifacts = await listArtifacts();
    const sent = artifacts.filter((a) => a.calibration);
    if (sent.length === 0) {
      console.log("No sent reviews with calibration data yet. Stats appear after you send reviews.");
    } else {
      const buckets: [string, (c: number) => boolean][] = [
        ["  <60%", (c) => c < 60],
        ["60-79%", (c) => c >= 60 && c < 80],
        ["80-89%", (c) => c >= 80 && c < 90],
        ["  90%+", (c) => c >= 90],
      ];
      console.log(`Calibration over ${sent.length} sent review(s):\n`);
      console.log("confidence  n   verdict-agree  ai-comments kept/edited/dropped");
      for (const [label, match] of buckets) {
        const group = sent.filter((a) => a.calibration!.aiConfidence != null && match(a.calibration!.aiConfidence));
        if (group.length === 0) continue;
        const agree = group.filter(
          (a) =>
            a.calibration!.aiRecommendation &&
            eventForRecommendation(a.calibration!.aiRecommendation) === a.calibration!.sentEvent,
        ).length;
        const totals = group.reduce(
          (acc, a) => {
            const c = a.calibration!;
            acc.total += c.aiCommentsTotal;
            acc.dropped += c.aiCommentsDropped;
            acc.edited += c.aiCommentsEdited;
            return acc;
          },
          { total: 0, dropped: 0, edited: 0 },
        );
        const kept = totals.total - totals.dropped;
        console.log(
          `${label}      ${String(group.length).padEnd(3)} ${`${agree}/${group.length}`.padEnd(14)}` +
            `${kept}/${totals.edited}/${totals.dropped} of ${totals.total}`,
        );
      }
    }

    const log = await readAutoSendLog();
    if (log.length > 0) {
      const wouldSend = log.filter((e) => e.decision.startsWith("would send")).length;
      const autoSent = log.filter((e) => e.sent).length;
      console.log(
        `\nAuto-send log (${cerberHome()}/autosend.ndjson): ${log.length} decision(s), ` +
          `${wouldSend} shadow candidate(s), ${autoSent} auto-sent.`,
      );
    }
  });

program
  .command("serve", { isDefault: true })
  .description(
    "Start the review cockpit — an inbox: it polls GitHub for PRs awaiting your review and drafts " +
      "a review for each, so they're ready when you open it. --no-poll / --no-auto-review to tame it.",
  )
  .option("-p, --port <port>", "port", "4820")
  .option("-H, --host <host>", "host to bind (0.0.0.0 for VPS — requires --token)", "127.0.0.1")
  .option("-t, --token <token>", "require this token on every request (env: CERBER_TOKEN)")
  .option("--no-poll", "don't poll GitHub for PRs awaiting your review (also disables auto-review)")
  .option("--no-auto-review", "list awaiting PRs but don't review them until you click review")
  .option("-d, --daemon", "(deprecated no-op — polling and auto-review are now the default)")
  .option("-i, --interval <minutes>", "poll interval (default: config daemon.intervalMinutes, 5)")
  .option("-R, --repo <owner/repo>", "repo(s) to watch (repeatable; default: config daemon.repos, all)", collect, [])
  .option("-P, --parallel <n>", "review concurrency (default: config daemon.parallel, 3)")
  .option("-m, --model <model>", "Claude model override for unattended reviews")
  .option(
    "--no-source",
    "review the diff alone, with no local checkout of the PR head (applies to daemon runs and cockpit re-reviews)",
  )
  .option(
    "--no-trust",
    "ignore the configured trust rules: every review here stays read-only, even for repos you trust",
  )
  .option(
    "--auto-send",
    "ACTUALLY auto-send APPROVE verdicts at/above --auto-send-threshold (default: shadow mode, which only logs what would be sent)",
  )
  .option("--auto-send-threshold <pct>", "how sure the review must be of itself to auto-send", "90")
  .option("--insecure", "allow binding a non-localhost host without a token (NOT recommended)")
  .action(
    async (opts: {
      port: string;
      host: string;
      token?: string;
      poll: boolean;
      autoReview: boolean;
      daemon?: boolean;
      interval?: string;
      repo: string[];
      parallel?: string;
      model?: string;
      source: boolean;
      trust: boolean;
      autoSend?: boolean;
      autoSendThreshold: string;
      insecure?: boolean;
    }) => {
      const token = opts.token ?? process.env.CERBER_TOKEN;
      const isLocal = ["127.0.0.1", "localhost", "::1"].includes(opts.host);
      if (!isLocal && !token && !opts.insecure) {
        console.error(
          `Refusing to bind ${opts.host} without auth: anyone reaching this port could send reviews as you.\n` +
            `Pass --token <secret> (or CERBER_TOKEN), or --insecure if the network is trusted.`,
        );
        process.exit(1);
      }
      const threshold = Math.min(100, Math.max(50, Number(opts.autoSendThreshold) || 90));
      if (opts.autoSend) {
        console.log(
          `⚠ auto-send is ON: APPROVE verdicts with confidence ≥ ${threshold}% will be sent to GitHub as you, without a per-review confirmation.\n` +
            `  Every decision is logged to ${cerberHome()}/autosend.ndjson. COMMENT/REQUEST_CHANGES always wait for a human.`,
        );
      }
      if (opts.daemon) {
        console.log("Note: --daemon is deprecated — polling and auto-review are on by default now.");
      }

      // Config holds the defaults and is re-read by the daemon on every poll
      // (so the cockpit's Settings toggles apply live); a --no-* flag caps
      // this run only, and --no-poll skips the loop entirely.
      const config = await loadConfig();
      const d = config.daemon;

      // Trust means "run this PR's code". A human clicking review accepted that
      // per PR; auto-review does it unattended, on whatever lands in the queue.
      if (opts.poll && d.poll && opts.autoReview && d.autoReview && opts.trust && config.trust.length > 0) {
        console.log(
          `⚠ ${config.trust.length} trust rule(s) in ${configPath()}: unattended reviews will run commands from ` +
            `matching PRs, with nobody watching. Pass --no-trust to keep every review read-only, ` +
            `or --no-auto-review to only review on click.`,
        );
      }

      const daemon = opts.poll
        ? startDaemon({
            repos: opts.repo.length > 0 ? opts.repo : d.repos,
            intervalMs:
              Math.max(1, opts.interval !== undefined ? Number(opts.interval) || d.intervalMinutes : d.intervalMinutes) *
              60_000,
            parallel: Math.max(1, opts.parallel !== undefined ? Number(opts.parallel) || d.parallel : d.parallel),
            model: opts.model,
            withSource: opts.source,
            trust: opts.trust ? undefined : false,
            autoReview: opts.autoReview,
            autoSend: opts.autoSend ? "on" : "shadow",
            autoSendThreshold: threshold,
          })
        : undefined;
      if (!opts.poll) {
        console.log("Polling is off (--no-poll) — the queue only shows what you review by hand.");
      }
      await startServer({
        port: Number(opts.port),
        host: opts.host,
        token,
        daemon,
        withSource: opts.source,
        trust: opts.trust ? undefined : false,
      });
    },
  );

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
