import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The release is the one thing here that cannot fail on a pull request. It runs
 * only on the merge to `main`, where a mistake costs a release rather than a red
 * check — which is how v0.35.0 came to be lost. These are the checks that run on
 * the PR instead. `.releaserc.md` has the reasoning behind each of them.
 */
const require = createRequire(import.meta.url);
const root = (name: string): URL => new URL(`../${name}`, import.meta.url);
const read = (name: string): string => readFileSync(root(name), "utf8");
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const releaserc = JSON.parse(read(".releaserc.json")) as Record<string, unknown> & {
  plugins: (string | [string, unknown])[];
};
const manifest = require("../package.json") as {
  version: string;
  release?: unknown;
  scripts: Record<string, string>;
};

const pluginName = (p: string | [string, unknown]): string => (Array.isArray(p) ? p[0] : p);

describe("release config", () => {
  /**
   * Everything below reads `.releaserc.json`, so first prove that is the file
   * semantic-release reads. It resolves config through `cosmiconfig("release")`
   * with the default search places, which try `package.json` and then
   * `.releaserc` *before* `.releaserc.json` — so either of those would shadow
   * it, leaving these assertions inspecting a file nothing loads while the live
   * config re-added the plugin below.
   */
  it("is loaded from the file these tests check", () => {
    expect(
      manifest.release,
      "a `release` key in package.json outranks .releaserc.json; see .releaserc.md",
    ).toBeUndefined();
    expect(existsSync(root(".releaserc")), "a bare .releaserc outranks .releaserc.json; see .releaserc.md").toBe(
      false,
    );
  });

  /**
   * `plugins` is not the only key that loads one. `lib/plugins/index.js` does
   * `options = { ...plugins, ...options }`, so a top-level step key —
   * `prepare`, `publish`, `verifyConditions`, … — loads a plugin on its own,
   * and `extends` pulls in a shared config's step keys wholesale. Either would
   * put `@semantic-release/git` back in `prepare` with the allowlist below
   * still passing, so pin the file's shape before reading it.
   */
  it("wires plugins only through the key these tests check", () => {
    expect(
      Object.keys(releaserc).sort(),
      "a step key or `extends` can load a release plugin past the allowlist; see .releaserc.md",
    ).toEqual(["branches", "plugins"]);
  });

  it("runs only plugins that write no branch, npm before github", () => {
    // An allowlist rather than a ban on `@semantic-release/git`, because it is
    // not the only way back to the outage: `@semantic-release/exec` can run its
    // own `git push`, and a fork or shared config can arrive under any name.
    // The order is load-bearing too — `.releaserc.md`'s recovery reasons from
    // npm publishing before the GitHub release, which is this array, not code.
    expect(
      releaserc.plugins.map(pluginName),
      "a new release plugin must be checked for whether it pushes a branch; see .releaserc.md",
    ).toEqual([
      "@semantic-release/commit-analyzer",
      "@semantic-release/release-notes-generator",
      "@semantic-release/npm",
      "@semantic-release/github",
    ]);
  });

  it("keeps the reasoning next to the config", () => {
    // `.releaserc.json` cannot hold a comment, so the why lives beside it —
    // and it is where the failure messages here send a reader, so it has to be
    // there to be read.
    expect(existsSync(root(".releaserc.md")), ".releaserc.md is where these failures send the reader").toBe(true);
  });
});

describe("the sentinel version", () => {
  const guard = fileURLToPath(root("scripts/refuse-sentinel-publish.mjs"));
  /** A dry-run flag leaking in from the caller would make the refusal vacuous. */
  const cleanEnv = (): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    delete env.npm_config_dry_run;
    return env;
  };

  it("is what the manifest carries", () => {
    // The real version is written on the way to the registry and never
    // committed back, so whatever sits here describes no release. A number
    // would quietly name the release before last.
    expect(
      manifest.version,
      "package.json version must stay the sentinel — the release never commits one; see .releaserc.md",
    ).toBe("0.0.0-development");
  });

  it("is refused by prepublishOnly, which runs the guard before the build", () => {
    expect(
      manifest.scripts.prepublishOnly,
      "the guard must run before the build, and its failure must stop the publish",
    ).toMatch(/^node scripts\/refuse-sentinel-publish\.mjs && /);
  });

  /**
   * Run it rather than assert its shape. A guard that always exits 0 — an
   * inverted comparison, a typo in the sentinel constant, a `|| true` — reads
   * identically from the outside, and this one sits in the release's own path:
   * if it were to throw on a *real* version it would fail nothing until the
   * merge to `main`, which is the failure class this file exists to prevent.
   */
  it("refuses a publish of the committed tree", () => {
    const { status, stderr } = spawnSync(process.execPath, [guard], {
      encoding: "utf8",
      env: cleanEnv(),
      timeout: 30_000,
    });
    expect(status, "a publish of the sentinel must be refused").toBe(1);
    expect(stderr).toMatch(/Refusing to publish 0\.0\.0-development/);
  });

  it("allows a publish once the version is real, as it is in CI", () => {
    // @semantic-release/npm writes the version in `prepare`, before `publish`,
    // so this is the state every real release reaches the guard in — and the
    // direction that matters most, because getting it wrong blocks releases
    // rather than letting one through. The guard resolves the manifest relative
    // to itself, so the fixture mirrors the layout rather than the path.
    const dir = mkdtempSync(join(tmpdir(), "cerber-publish-guard-"));
    try {
      mkdirSync(join(dir, "scripts"));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "probe", version: "1.2.3" }));
      const copy = join(dir, "scripts", "refuse-sentinel-publish.mjs");
      writeFileSync(copy, readFileSync(guard));
      const { status, stderr } = spawnSync(process.execPath, [copy], {
        encoding: "utf8",
        env: cleanEnv(),
        timeout: 30_000,
      });
      expect(status, `the guard must not block a real release: ${stderr}`).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stands aside for a dry run, which publishes nothing", () => {
    // Both npm and pnpm set this for `publish --dry-run`. It is also the escape
    // hatch for @semantic-release/npm's unused `attemptPublishDryRun`: were a
    // later version to call it from `verifyConditions` — before `prepare`
    // writes the real version — this guard would otherwise fail every release.
    const { status } = spawnSync(process.execPath, [guard], {
      encoding: "utf8",
      env: { ...cleanEnv(), npm_config_dry_run: "true" },
      timeout: 30_000,
    });
    expect(status, "`publish --dry-run` publishes nothing, so there is nothing to refuse").toBe(0);
  });

  it("is what the CLI reports, because it reads the manifest", () => {
    // Not a source match: `const version = "0.5.0"` passed to `.version(version)`
    // satisfies any shape assertion while being the exact drift the comment
    // above that line records. Run it and compare.
    const { stdout, stderr, status, error } = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli/index.ts", "--version"],
      { cwd: repoRoot, encoding: "utf8", timeout: 60_000 },
    );
    expect(status, `the CLI must run: ${error?.message ?? ""}${stderr}`).toBe(0);
    expect(stdout.trim(), "--version must come from the manifest, not a literal").toBe(manifest.version);
  });
});

type Step = { uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
type Job = {
  concurrency?: string | { group?: string; "cancel-in-progress"?: boolean };
  steps?: Step[];
  secrets?: unknown;
};
type Workflow = { jobs: Record<string, Job | undefined> };

/**
 * Every secret the workflow names. Four of the forms hand over *all* of them at
 * once, so they cannot be reported as a name — they are reported as themselves,
 * which is what makes them fail the equality below rather than pass unseen.
 *
 * Actions resolves contexts and functions case-insensitively, hence the `i`.
 */
function secretsNamedIn(workflow: Workflow): string[] {
  const source = JSON.stringify(workflow);
  const found = new Set<string>();
  for (const m of source.matchAll(
    /secrets\s*(?:\.\s*([A-Za-z0-9_]+)|\[\s*\\?["']([A-Za-z0-9_]+)\\?["']\s*\])/gi,
  )) {
    found.add((m[1] ?? m[2] ?? "").toUpperCase());
  }
  if (Object.values(workflow.jobs ?? {}).some((job) => job?.secrets === "inherit")) {
    found.add("<every secret, via `secrets: inherit`>");
  }
  if (/toJson\s*\(\s*secrets/i.test(source)) found.add("<every secret, via toJSON(secrets)>");
  if (/secrets\s*\[\s*(?!\\?["'])/i.test(source)) found.add("<unknown secret, via a dynamic lookup>");
  return [...found].sort();
}

/**
 * The config file was never the only way to undo this. These read the workflow
 * as YAML rather than as text, so they see what Actions sees: a `run: |` block
 * and a flow-style `with: { token: … }` are the same to a parser, and a comment
 * cannot trip them.
 */
describe("the release workflow", () => {
  const workflow = parse(read(".github/workflows/ci.yml")) as Workflow;
  const release = workflow.jobs.release;

  it("has a release job at all", () => {
    // Everything below reads this job, so a rename would otherwise turn every
    // assertion in here into a vacuous pass on an undefined object.
    expect(release, "the guards below all read jobs.release").toBeDefined();
  });

  it("names no credential beyond the job's own GITHUB_TOKEN", () => {
    // Not needing a stored credential is exactly what lets the release keep the
    // pull-request rule instead of bypassing it. This covers the whole file,
    // not just the release job: a PAT anywhere in CI is a credential on this
    // repo, and the release is the job that could use it to push.
    expect(
      secretsNamedIn(workflow),
      "a stored credential in CI could push to main, which is what not needing one buys; see .releaserc.md",
    ).toEqual(["GITHUB_TOKEN"]);
  });

  /**
   * The negative control for the check above, and the reason it exists: its
   * first version asserted `/secrets:\s*inherit/` against `JSON.stringify`,
   * where the text is `"secrets":"inherit"`. It could never match. A guard that
   * cannot fail is indistinguishable from one that works, so every form it
   * claims to catch is exercised here against a fixture.
   */
  it("would notice each way a credential can arrive", () => {
    const evasions = {
      "a plain reference": "jobs:\n  r:\n    env:\n      X: ${{ secrets.RELEASE_PAT }}\n",
      "an upper-case context": "jobs:\n  r:\n    env:\n      X: ${{ SECRETS.RELEASE_PAT }}\n",
      "a bracket lookup": "jobs:\n  r:\n    env:\n      X: ${{ secrets['RELEASE_PAT'] }}\n",
      "`secrets: inherit`": "jobs:\n  r:\n    uses: o/r/.github/workflows/w.yml@v1\n    secrets: inherit\n",
      "toJSON(secrets)": "jobs:\n  r:\n    env:\n      X: ${{ toJSON(secrets) }}\n",
      "a dynamic lookup": "jobs:\n  r:\n    env:\n      X: ${{ secrets[env.NAME] }}\n",
    };
    for (const [form, yaml] of Object.entries(evasions)) {
      expect(secretsNamedIn(parse(yaml) as Workflow), `the scan does not see ${form}`).not.toEqual([]);
    }
    // And it must not cry wolf on a workflow that names nothing.
    expect(secretsNamedIn(parse("jobs:\n  r:\n    steps:\n      - run: echo hi\n") as Workflow)).toEqual([]);
  });

  it("hands the checkout no credential of its own", () => {
    // The checkout is the step whose credential would outlive it and enable the
    // push. `persist-credentials: false` is the hardening, not a credential, so
    // it is allowed — but `true`, a `token:` or an `ssh-key:` are not.
    const checkouts = (release?.steps ?? []).filter((step) => /actions\/checkout/.test(step.uses ?? ""));
    expect(checkouts.length, "the release job must still check out the repo").toBe(1);
    const given = Object.entries(checkouts[0]?.with ?? {}).filter(
      ([key, value]) =>
        /^(token|ssh-key|password)$/i.test(key) || (/^persist-credentials$/i.test(key) && value !== false),
    );
    expect(
      given.map(([key]) => key),
      "a credential given to the checkout outlives the step and can push; see .releaserc.md",
    ).toEqual([]);
  });

  it("passes semantic-release no config of its own", () => {
    // `--plugins` and `--extends` override the config file entirely, so every
    // assertion in "release config" above would be inspecting a file the run
    // ignores. A parsed `run` is one string whether it was written inline or
    // as a block, so a flag cannot hide in the formatting.
    const invocations = (release?.steps ?? [])
      .map((step) => step.run)
      .filter((run): run is string => !!run && /\bsemantic-release\b/.test(run));
    expect(invocations.length, "the release step must still invoke semantic-release").toBe(1);
    expect(invocations[0]?.trim(), "a CLI flag overrides .releaserc.json; see .releaserc.md").toMatch(
      /^(pnpm exec|npx|yarn) semantic-release$/,
    );
  });

  it("serialises releases rather than racing them", () => {
    // Two merges in quick succession otherwise both compute the same next
    // version. Cancelling one mid-release is worse: between the tag push and
    // the publish, a cancel leaves a tag with nothing published behind it —
    // the one state here that needs a human, per .releaserc.md.
    const concurrency =
      typeof release?.concurrency === "string" ? { group: release.concurrency } : release?.concurrency;
    expect(concurrency?.group, "concurrent releases race for the same version").toBe("release");
    // Actions defaults this to false, so an omitted value is the safe one.
    expect(
      concurrency?.["cancel-in-progress"] ?? false,
      "a cancelled release can leave a tag with nothing behind it",
    ).toBe(false);
  });
});
