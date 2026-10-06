#!/usr/bin/env node
/**
 * Runs from `prepublishOnly`, so it catches a plain `npm publish` or
 * `pnpm publish` from a working tree. It is not a perimeter:
 * `--ignore-scripts` and publishing a pre-built tarball both go around it.
 *
 * The committed version is the sentinel `0.0.0-development` (see
 * `.releaserc.md`). In CI that is already gone by the time this runs —
 * `@semantic-release/npm` writes the real version in `prepare`, before
 * `publish` — so this only ever fires for a publish from a working tree, where
 * it would otherwise put `0.0.0-development` on the registry under the `latest`
 * tag. npm versions are permanent, and `latest` is what every default install
 * follows.
 *
 * Before the sentinel existed this mistake failed by itself: the manifest held
 * the last released number and the registry rejected it as a duplicate. That
 * accident is what the sentinel removed, so it is the one this replaces it with.
 */
import { readFileSync } from "node:fs";

const SENTINEL = "0.0.0-development";
const manifest = new URL("../package.json", import.meta.url);
const { version } = JSON.parse(readFileSync(manifest, "utf8"));

/**
 * A dry run publishes nothing, so there is nothing to refuse — and saying no
 * to it would cost more than it saves. `npm publish --dry-run` is how someone
 * checks what the tarball would contain, and `@semantic-release/npm` carries an
 * `attemptPublishDryRun` helper it does not currently call: were a later
 * version to call it from `verifyConditions`, which runs *before* `prepare`
 * writes the real version, this guard would see the sentinel and fail every
 * release on a routine dependency bump.
 */
if (process.env.npm_config_dry_run === "true") {
  process.exit(0);
}

if (version === SENTINEL) {
  console.error(
    `Refusing to publish ${SENTINEL}.\n\n` +
      "Releases are cut by semantic-release on a merge to main, which writes the\n" +
      "real version before publishing. Nothing should publish by hand — see\n" +
      ".releaserc.md. If you are deliberately publishing a one-off, set a real\n" +
      "version first and remember it can never be reused.",
  );
  process.exit(1);
}
