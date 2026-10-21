import { createRequire } from "node:module";

/**
 * The published version, read from the manifest rather than typed here — a
 * hand-maintained copy drifted to 0.5.0 while 0.30.0 shipped, and `--version`
 * is the first thing anyone runs to decide whether a project is alive. The
 * cockpit's settings screen shows the same string, read off the running server.
 *
 * In the published package that manifest is the one the release bumped, so this
 * is the real version wherever anyone installed cerber. In a clone it reads
 * `0.0.0-development`, because nothing commits the bump back to `main` and a
 * number left behind there would quietly describe the release before last. A
 * sentinel cannot drift: it says "built from source", which is true, instead of
 * naming a version this build is not.
 */
export const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };
