import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Cerber is three programs in a trench coat: `gh` fetches the PR, `git` fetches
 * the head, `claude` writes the review. When one of them is missing or logged
 * out, every failure that follows is second-hand — the poll retries into
 * `status.lastPollError`, the cockpit binds its port and shows an empty queue,
 * and the only honest explanation lives somewhere the user is not looking.
 *
 * So the checks happen once, at the front, and say what to run next.
 */
export type CheckStatus = "ok" | "missing" | "unauthenticated";

export type Check = {
  /** What was checked, as the user would name it. */
  name: string;
  status: CheckStatus;
  /** Present when `ok` — the version line, so `doctor` shows what it found. */
  detail?: string;
  /** Present when not `ok` — one line the user can act on. */
  fix?: string;
};

export function isBlocking(check: Check): boolean {
  return check.status !== "ok";
}

async function run(bin: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args);
    return { ok: true, out: (stdout || stderr).trim() };
  } catch (err: unknown) {
    const e = err as { code?: string; stderr?: string; stdout?: string; message?: string };
    // ENOENT is "not installed"; a non-zero exit is the tool answering "no".
    if (e.code === "ENOENT") return { ok: false, out: "ENOENT" };
    return { ok: false, out: (e.stderr || e.stdout || e.message || "").trim() };
  }
}

export async function checkGh(): Promise<Check> {
  const version = await run("gh", ["--version"]);
  if (!version.ok && version.out === "ENOENT") {
    return {
      name: "gh (GitHub CLI)",
      status: "missing",
      fix: "Install it: https://cli.github.com — then run `gh auth login`.",
    };
  }
  // `gh auth status` exits non-zero when no account is logged in, which is the
  // case that otherwise surfaces as an empty cockpit.
  const auth = await run("gh", ["auth", "status"]);
  if (!auth.ok) {
    return {
      name: "gh (GitHub CLI)",
      status: "unauthenticated",
      fix: "Run `gh auth login` — cerber reads PRs as you, and sends as you.",
    };
  }
  return { name: "gh (GitHub CLI)", status: "ok", detail: version.out.split("\n")[0] };
}

export async function checkClaude(): Promise<Check> {
  const version = await run("claude", ["--version"]);
  if (!version.ok && version.out === "ENOENT") {
    return {
      name: "claude (Claude Code)",
      status: "missing",
      fix: "Install it: https://claude.com/claude-code — cerber rides your login, there is no API-key path.",
    };
  }
  if (!version.ok) {
    return {
      name: "claude (Claude Code)",
      status: "unauthenticated",
      fix: "Run `claude` once and log in — a review is drafted through your Claude Code session.",
    };
  }
  return { name: "claude (Claude Code)", status: "ok", detail: version.out.split("\n")[0] };
}

export async function checkGit(): Promise<Check> {
  const version = await run("git", ["--version"]);
  if (!version.ok) {
    return {
      name: "git",
      status: "missing",
      fix: "Install git — cerber fetches each PR head into ~/.cerber/src to review the code, not just the diff.",
    };
  }
  return { name: "git", status: "ok", detail: version.out.split("\n")[0] };
}

/** Everything cerber shells out to, checked in parallel. */
export async function preflight(): Promise<Check[]> {
  return Promise.all([checkGh(), checkClaude(), checkGit()]);
}

/** The blocking checks, formatted as the message printed instead of failing later. */
export function formatBlockers(checks: Check[]): string {
  const bad = checks.filter(isBlocking);
  const lines = bad.map((c) => {
    const what = c.status === "missing" ? "not installed" : "not logged in";
    return `  ✗ ${c.name} — ${what}\n    ${c.fix ?? ""}`.trimEnd();
  });
  return `cerber needs these before it can do anything:\n\n${lines.join("\n")}\n\nRun \`cerber doctor\` to re-check.`;
}
