import { execFile } from "node:child_process";
import { Mock, beforeEach, describe, expect, it, vi } from "vitest";
import { checkClaude, checkGh, formatBlockers, isBlocking, preflight } from "./preflight.js";

// Same shape as gh.test.ts: `promisify(execFile)` honours this symbol, so the
// mock resolves to `{ stdout }` the way the real one does.
vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  (execFile as unknown as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")] = (
    ...args: unknown[]
  ) => Promise.resolve(execFile(...(args as [])));
  return { execFile };
});
const exec = execFile as unknown as Mock;

const enoent = () => Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
const exitNonZero = (stderr: string) => Object.assign(new Error("exited 1"), { stderr });

beforeEach(() => vi.clearAllMocks());

describe("checkGh", () => {
  it("is ok when gh is installed and logged in", async () => {
    exec.mockResolvedValueOnce({ stdout: "gh version 2.62.0 (2026-09-01)\n" });
    exec.mockResolvedValueOnce({ stdout: "Logged in to github.com account someone\n" });
    expect(await checkGh()).toMatchObject({ status: "ok", detail: "gh version 2.62.0 (2026-09-01)" });
  });

  it("reports missing — not unauthenticated — when gh is not installed", async () => {
    exec.mockRejectedValueOnce(enoent());
    const check = await checkGh();
    expect(check.status).toBe("missing");
    expect(check.fix).toContain("cli.github.com");
  });

  // The case that used to surface as a cockpit with an empty queue: gh is
  // there, so nothing throws, and every poll fails into lastPollError instead.
  it("reports unauthenticated when `gh auth status` exits non-zero", async () => {
    exec.mockResolvedValueOnce({ stdout: "gh version 2.62.0\n" });
    exec.mockRejectedValueOnce(exitNonZero("You are not logged into any GitHub hosts."));
    const check = await checkGh();
    expect(check.status).toBe("unauthenticated");
    expect(check.fix).toContain("gh auth login");
  });
});

describe("checkClaude", () => {
  // `claude --version` answers the same logged in or out, so a pass here must
  // not read as "your session works" — it said everything was fine while the
  // first review failed on a logged-out CLI.
  it("does not claim to have checked the login", async () => {
    exec.mockResolvedValueOnce({ stdout: "2.1.278 (Claude Code)\n" });
    const check = await checkClaude();
    expect(check.status).toBe("ok");
    expect(check.note).toMatch(/login not checked/);
  });

  it("points at Claude Code, and says there is no API-key path", async () => {
    exec.mockRejectedValueOnce(enoent());
    const check = await checkClaude();
    expect(check.status).toBe("missing");
    expect(check.fix).toContain("no API-key path");
  });
});

describe("preflight", () => {
  it("checks gh, claude and git", async () => {
    exec.mockResolvedValue({ stdout: "ok\n" });
    const checks = await preflight();
    expect(checks.map((c) => c.name)).toEqual(["gh (GitHub CLI)", "claude (Claude Code)", "git"]);
    expect(checks.some(isBlocking)).toBe(false);
  });

  // `--no-source` reviews the diff alone and never clones the PR head, so a
  // missing git must not stop it — the first cut blocked that run too.
  it("skips git when the run will not clone a checkout", async () => {
    exec.mockResolvedValue({ stdout: "ok\n" });
    const checks = await preflight({ git: false });
    expect(checks.map((c) => c.name)).toEqual(["gh (GitHub CLI)", "claude (Claude Code)"]);
  });
});

describe("formatBlockers", () => {
  it("lists only the broken ones, each with its fix", () => {
    const out = formatBlockers([
      { name: "gh (GitHub CLI)", status: "unauthenticated", fix: "Run `gh auth login`." },
      { name: "claude (Claude Code)", status: "ok", detail: "1.2.3" },
      { name: "git", status: "ok", detail: "git version 2.46" },
    ]);
    expect(out).toContain("gh (GitHub CLI) — not logged in");
    expect(out).toContain("Run `gh auth login`.");
    expect(out).not.toContain("claude");
    expect(out).toContain("cerber doctor");
  });
});
