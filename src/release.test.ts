import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * The release config is the one thing in this repo that cannot fail in CI on
 * the pull request — it only runs on the merge to `main`, where a mistake costs
 * a release rather than a red check. Both invariants below were prose in
 * `.releaserc.md` first, and prose did not stop the outage that put them there.
 */
const require = createRequire(import.meta.url);
const releaserc = JSON.parse(readFileSync(new URL("../.releaserc.json", import.meta.url), "utf8")) as {
  plugins: (string | [string, unknown])[];
};
const manifest = require("../package.json") as { version: string };

const pluginName = (p: string | [string, unknown]): string => (Array.isArray(p) ? p[0] : p);

describe("release config", () => {
  it("has no plugin that pushes to main", () => {
    // `@semantic-release/git` commits the bumped manifest and pushes it, which
    // the ruleset on `main` rejects — the whole release then dies in `prepare`
    // with nothing published. Adding it back is a one-line change that stays
    // green until the next merge, so this is where it gets caught instead.
    expect(releaserc.plugins.map(pluginName)).not.toContain("@semantic-release/git");
  });

  it("keeps the committed version a sentinel", () => {
    // The real version is written on the way to the registry and never
    // committed back, so whatever sits here describes no release. A number
    // would quietly name the release before last; see `.releaserc.md`.
    expect(manifest.version).toBe("0.0.0-development");
  });
});
