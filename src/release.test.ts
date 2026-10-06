import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * The release is the one thing here that cannot fail on a pull request. It runs
 * only on the merge to `main`, where a mistake costs a release rather than a red
 * check — which is how v0.35.0 came to be lost. These are the checks that run on
 * the PR instead. `.releaserc.md` has the reasoning behind each of them.
 */
const require = createRequire(import.meta.url);
const root = (name: string): URL => new URL(`../${name}`, import.meta.url);
const read = (name: string): string => readFileSync(root(name), "utf8");

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
    expect(manifest.release, "a `release` key in package.json outranks .releaserc.json").toBeUndefined();
    expect(existsSync(root(".releaserc")), "a bare .releaserc outranks .releaserc.json").toBe(false);
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

  it("runs only plugins that write no branch", () => {
    // An allowlist rather than a ban on `@semantic-release/git`, because it is
    // not the only way back to the outage: `@semantic-release/exec` can run its
    // own `git push`, and a fork or shared config can arrive under any name.
    // Adding a plugin should cost a deliberate edit here and in `.releaserc.md`.
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
    // `.releaserc.json` cannot hold a comment, so the why lives beside it. A
    // sidecar's weakness is going missing or stale while the config stays, and
    // every assertion here names it in its failure message — so it has to exist.
    expect(existsSync(root(".releaserc.md")), ".releaserc.md is where every failure here points").toBe(true);
  });
});

describe("release pipeline", () => {
  const workflow = read(".github/workflows/ci.yml");

  it("keeps the committed version a sentinel", () => {
    // The real version is written on the way to the registry and never
    // committed back, so whatever sits here describes no release. A number
    // would quietly name the release before last.
    expect(
      manifest.version,
      "package.json version must stay the sentinel — the release never commits one; see .releaserc.md",
    ).toBe("0.0.0-development");
  });

  it("refuses to publish the sentinel by hand", () => {
    // Before the sentinel, a stray `npm publish` from a clone failed by itself:
    // the registry rejected the last released number as a duplicate. The
    // sentinel removed that accident, so this replaces it.
    expect(
      manifest.scripts.prepublishOnly,
      "prepublishOnly is the last thing between `npm publish` and the registry",
    ).toContain("scripts/refuse-sentinel-publish.mjs");
    expect(existsSync(root("scripts/refuse-sentinel-publish.mjs"))).toBe(true);
  });

  /**
   * The whole design rests on there being no credential in CI that can push to
   * `main` — that is why the release may keep the pull-request rule instead of
   * bypassing it. Nothing else enforces it: a PAT in the job's env, or handed to
   * `actions/checkout` as `token:`, would restore the push and fail nothing.
   */
  it("holds no credential beyond the job's own GITHUB_TOKEN", () => {
    const used = [...new Set([...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
    expect(
      used,
      "a stored credential in CI could push to main, which is what not needing one buys; see .releaserc.md",
    ).toEqual(["GITHUB_TOKEN"]);
    expect(workflow, "a `token:` input hands a credential to an action").not.toMatch(/^\s*token:/m);
  });

  it("passes semantic-release no config of its own", () => {
    // `--plugins` and `--extends` override the config file entirely, so the
    // assertions above would be inspecting a file the run ignores.
    const invocations = workflow
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^(- )?run:.*semantic-release/.test(line));
    expect(invocations, "a CLI flag overrides .releaserc.json; see .releaserc.md").toEqual([
      "run: pnpm exec semantic-release",
    ]);
  });

  it("queues releases rather than racing them", () => {
    // Two merges in quick succession would otherwise both compute the same next
    // version. Cancelling one mid-release is worse still: between the tag push
    // and the publish, a cancel leaves a tag with no version behind it.
    expect(workflow, "concurrent releases race for the same version").toMatch(/^\s*group: release$/m);
    expect(workflow, "a cancelled release can leave a tag with nothing published").toMatch(
      /^\s*cancel-in-progress: false$/m,
    );
  });

  it("reports a version it did not hard-code", () => {
    // The published package reports the truth only because the CLI reads the
    // manifest at runtime. A literal here is the exact drift the comment above
    // that line records — a hand-maintained copy said 0.5.0 while 0.30.0 shipped.
    const cli = read("src/cli/index.ts");
    expect(cli, "--version must come from the manifest, not a literal").toContain(".version(version)");
    expect(cli, "a hard-coded version stops following the release").not.toMatch(/\.version\(\s*["'`]/);
  });
});
