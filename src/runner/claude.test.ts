import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildClaudeArgs, extractJson, runClaude } from "./claude.js";

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
    // A stand-in that ignores its arguments and hangs, the way a wedged run does.
    const bin = path.join(os.tmpdir(), `cerber-hang-${process.pid}.sh`);
    await fs.writeFile(bin, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    try {
      await expect(runClaude("hi", { bin, timeoutMs: 100 })).rejects.toThrow(/did not finish within/);
    } finally {
      await fs.rm(bin, { force: true });
    }
  });

  it("surfaces a missing claude binary as a setup problem", async () => {
    await expect(runClaude("hi", { bin: "definitely-not-a-real-binary-xyz" })).rejects.toThrow(
      /Is Claude Code installed/,
    );
  });
});
