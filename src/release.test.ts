import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * The release config is the one thing here that cannot fail on a pull request.
 * It runs only on the merge to `main`, where a mistake costs a release rather
 * than a red check — which is how v0.35.0 came to be lost. These are the checks
 * that run on the PR instead. `.releaserc.md` has the reasoning.
 */
const require = createRequire(import.meta.url);
const root = (name: string): URL => new URL(`../${name}`, import.meta.url);
const releaserc = JSON.parse(readFileSync(root(".releaserc.json"), "utf8")) as Record<string, unknown> & {
  plugins: (string | [string, unknown])[];
};
const manifest = require("../package.json") as { version: string; release?: unknown };

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

  it("keeps the committed version a sentinel", () => {
    // The real version is written on the way to the registry and never
    // committed back, so whatever sits here describes no release. A number
    // would quietly name the release before last.
    expect(
      manifest.version,
      "package.json version must stay the sentinel — the release never commits one; see .releaserc.md",
    ).toBe("0.0.0-development");
  });
});
