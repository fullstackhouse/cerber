import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildClaudeArgs, extractJson, runClaude, unauthenticatedEnv } from "./claude.js";

describe("buildClaudeArgs", () => {
  it("asks for headless JSON output", () => {
    expect(buildClaudeArgs({})).toEqual(["-p", "--output-format", "json"]);
  });

  it("passes tool restrictions through as comma-separated lists", () => {
    const args = buildClaudeArgs({
      model: "opus",
      allowedTools: ["Read", "Grep"],
      disallowedTools: ["Bash"],
    });
    expect(args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--model",
      "opus",
      "--allowedTools",
      "Read,Grep",
      "--disallowedTools",
      "Bash",
    ]);
  });

  it("refuses workspace configuration when reviewing inside an untrusted checkout", () => {
    const args = buildClaudeArgs({ cwd: "/tmp/pr", isolateWorkspace: true });
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--settings") + 1]).toBe('{"disableAllHooks":true}');
  });

  it("omits empty tool lists rather than passing an empty flag", () => {
    expect(buildClaudeArgs({ allowedTools: [], disallowedTools: [] })).toEqual([
      "-p",
      "--output-format",
      "json",
    ]);
  });

  it("resumes an earlier session when asked to", () => {
    expect(buildClaudeArgs({ resumeSessionId: "sess-123" })).toEqual([
      "-p",
      "--output-format",
      "json",
      "--resume",
      "sess-123",
    ]);
  });

  it("starts fresh when no session is given", () => {
    // An empty string is "we never captured one", not a session to resume —
    // `--resume ""` would fail the run rather than start a new conversation.
    expect(buildClaudeArgs({ resumeSessionId: "" })).not.toContain("--resume");
    expect(buildClaudeArgs({})).not.toContain("--resume");
  });
});

describe("extractJson", () => {
  it("parses pure JSON", () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it("parses fenced JSON", () => {
    expect(extractJson('Here you go:\n```json\n{"a": 1}\n```\nDone.')).toEqual({ a: 1 });
  });

  it("parses JSON embedded in prose", () => {
    expect(extractJson('The review: {"a": {"b": 2}} — hope that helps')).toEqual({ a: { b: 2 } });
  });

  it("throws when there is no JSON", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("runClaude", () => {
  it("kills a run that never finishes, so the PR is not wedged forever", async () => {
    // A stand-in that hangs AND ignores SIGTERM, so "close" cannot arrive on
    // any platform. Waiting for it is what wedged CI; rejecting on the kill is
    // what fixes it.
    const bin = path.join(os.tmpdir(), `cerber-hang-${process.pid}.sh`);
    // Short enough to reap itself: SIGKILL reaches the shell, not the sleep it
    // spawned, and a leaked process in CI is somebody else's confusing failure.
    await fs.writeFile(bin, "#!/bin/sh\ntrap '' TERM\nsleep 3\n", { mode: 0o755 });
    try {
      const started = Date.now();
      await expect(runClaude("hi", { bin, timeoutMs: 100 })).rejects.toThrow(/did not finish within/);
      // Promptly, not "eventually when the child happens to die".
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await fs.rm(bin, { force: true });
    }
  });

  it("surfaces a missing claude binary as a setup problem", async () => {
    await expect(runClaude("hi", { bin: "definitely-not-a-real-binary-xyz" })).rejects.toThrow(
      /Is Claude Code installed/,
    );
  });

  /** A stand-in `claude` that prints one canned JSON wrapper and exits. */
  async function stubClaude(wrapper: unknown, run: (bin: string) => Promise<void>) {
    const bin = path.join(os.tmpdir(), `cerber-stub-${process.pid}-${Math.random().toString(36).slice(2)}.sh`);
    const json = JSON.stringify(wrapper).replace(/'/g, `'\\''`);
    await fs.writeFile(bin, `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${json}'\n`, { mode: 0o755 });
    try {
      await run(bin);
    } finally {
      await fs.rm(bin, { force: true });
    }
  }

  it("hands back the session id, so a later turn can resume this conversation", async () => {
    await stubClaude(
      { result: "ok", total_cost_usd: 1.5, session_id: "sess-abc", modelUsage: { opus: {} } },
      async (bin) => {
        const result = await runClaude("hi", { bin });
        expect(result.sessionId).toBe("sess-abc");
        expect(result.text).toBe("ok");
        expect(result.costUsd).toBe(1.5);
      },
    );
  });

  it("reports no session rather than guessing when the wrapper omits one", async () => {
    await stubClaude({ result: "ok" }, async (bin) => {
      expect((await runClaude("hi", { bin })).sessionId).toBeNull();
    });
  });
});

describe("unauthenticatedEnv", () => {
  const env = () => unauthenticatedEnv({ PATH: "/usr/bin", GH_TOKEN: "real-token" }, "/tmp/empty");

  it("keeps the rest of the environment, so the run still works", () => {
    expect(env().PATH).toBe("/usr/bin");
  });

  it("blanks every GitHub token a run could inherit", () => {
    expect(env().GH_TOKEN).toBe("");
    expect(env().GITHUB_TOKEN).toBe("");
  });

  it("points gh at an empty config dir instead of the user's login", () => {
    expect(env().GH_CONFIG_DIR).toBe("/tmp/empty");
  });

  it("disables system git config, not just the global one", () => {
    // GIT_CONFIG_SYSTEM does not suppress macOS's Command Line Tools config,
    // which supplies credential.helper=osxkeychain — a push succeeded with it.
    expect(env().GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env().GIT_CONFIG_GLOBAL).toBe("/dev/null");
  });

  it("never lets git fall back to an interactive prompt", () => {
    expect(env().GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("closes the ssh route too, not just https", () => {
    // A run could point the remote at git@github.com and ride the user's keys.
    expect(env().SSH_AUTH_SOCK).toBe("");
    expect(env().GIT_SSH_COMMAND).toContain("IdentityAgent=none");
    // IdentitiesOnly alone still permits ssh's built-in key paths — measured
    // authenticating to GitHub without this.
    expect(env().GIT_SSH_COMMAND).toContain("IdentityFile=/dev/null");
    expect(env().GIT_SSH_COMMAND).toContain("-F /dev/null");
  });
});
