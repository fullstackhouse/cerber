import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildClaudeArgs, extractJson, readEvents, runClaude, unauthenticatedEnv } from "./claude.js";

describe("buildClaudeArgs", () => {
  it("asks for a streamed run, so it can be watched while it works", () => {
    // --verbose is not decoration: the CLI refuses stream-json with --print
    // without it.
    expect(buildClaudeArgs({})).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
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
      "stream-json",
      "--verbose",
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
      "stream-json",
      "--verbose",
    ]);
  });

  it("resumes an earlier session when asked to", () => {
    expect(buildClaudeArgs({ resumeSessionId: "sess-123" })).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
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

  /** A stand-in `claude` that streams the given events, one per line, and exits. */
  async function stubClaude(events: unknown[], run: (bin: string) => Promise<void>) {
    const bin = path.join(os.tmpdir(), `cerber-stub-${process.pid}-${Math.random().toString(36).slice(2)}.sh`);
    const lines = events.map((e) => JSON.stringify(e)).join("\n").replace(/'/g, `'\\''`);
    await fs.writeFile(bin, `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '${lines}'\n`, { mode: 0o755 });
    try {
      await run(bin);
    } finally {
      await fs.rm(bin, { force: true });
    }
  }

  it("hands back the session id, so a later turn can resume this conversation", async () => {
    await stubClaude(
      [{ type: "result", result: "ok", total_cost_usd: 1.5, session_id: "sess-abc", modelUsage: { opus: {} } }],
      async (bin) => {
        const result = await runClaude("hi", { bin });
        expect(result.sessionId).toBe("sess-abc");
        expect(result.text).toBe("ok");
        expect(result.costUsd).toBe(1.5);
      },
    );
  });

  it("reports no session rather than guessing when the run omits one", async () => {
    await stubClaude([{ type: "result", result: "ok" }], async (bin) => {
      expect((await runClaude("hi", { bin })).sessionId).toBeNull();
    });
  });

  it("reports each event as it arrives, not once the run is over", async () => {
    const events = [
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/x/a.ts" } }] } },
      { type: "result", result: "ok", session_id: "s" },
    ];
    await stubClaude(events, async (bin) => {
      const seen: string[] = [];
      await runClaude("hi", { bin, onEvent: (e) => seen.push(e.type) });
      expect(seen).toEqual(["system", "assistant", "result"]);
    });
  });

  it("survives a listener that throws — the answer is the point, not the narration", async () => {
    await stubClaude([{ type: "result", result: "ok" }], async (bin) => {
      const result = await runClaude("hi", {
        bin,
        onEvent: () => {
          throw new Error("boom");
        },
      });
      expect(result.text).toBe("ok");
    });
  });

  it("reads a final event that arrived without a trailing newline", async () => {
    // The result is the last line, so dropping an unterminated one throws away
    // a finished review for the want of a trailing byte.
    const bin = path.join(os.tmpdir(), `cerber-nonl-${process.pid}.sh`);
    await fs.writeFile(
      bin,
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"type":"result","result":"ok","session_id":"s"}'\n`,
      { mode: 0o755 },
    );
    try {
      expect((await runClaude("hi", { bin })).text).toBe("ok");
    } finally {
      await fs.rm(bin, { force: true });
    }
  });

  it("fails loudly when a run ends without a result event", async () => {
    await stubClaude([{ type: "system", subtype: "init" }], async (bin) => {
      await expect(runClaude("hi", { bin })).rejects.toThrow(/no result event/);
    });
  });
});

describe("readEvents", () => {
  it("keeps a half-arrived event back until the rest of it turns up", () => {
    // A tool result can be megabytes: one event routinely spans several chunks.
    const first = readEvents('{"type":"a"}\n{"type":"b"');
    expect(first.events.map((e) => e.type)).toEqual(["a"]);
    expect(first.rest).toBe('{"type":"b"');
    expect(readEvents(first.rest + '}\n').events.map((e) => e.type)).toEqual(["b"]);
  });

  it("skips a line it cannot parse rather than failing the run over it", () => {
    // The result comes from the closing event; dying here would throw away a
    // finished review over a stray byte.
    const { events } = readEvents('not json\n{"type":"result"}\n');
    expect(events.map((e) => e.type)).toEqual(["result"]);
  });

  it("ignores JSON that is not an event", () => {
    expect(readEvents('{"no":"type"}\n42\n').events).toEqual([]);
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
