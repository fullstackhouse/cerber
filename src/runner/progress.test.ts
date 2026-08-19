import { describe, expect, it } from "vitest";
import { ClaudeEvent } from "./claude.js";
import { describeEvent } from "./progress.js";

type Block = NonNullable<NonNullable<ClaudeEvent["message"]>["content"]>[number];

const assistant = (...content: Block[]): ClaudeEvent => ({ type: "assistant", message: { content } });

const tool = (name: string, input: Record<string, unknown>) =>
  assistant({ type: "tool_use", name, input });

describe("describeEvent", () => {
  it("says what the run is about to read, in the words the review itself uses", () => {
    expect(describeEvent(tool("Read", { file_path: "/tmp/pr/src/core/refresh.ts" }))).toEqual([
      "reading src/core/refresh.ts",
    ]);
  });

  it("keeps the useful tail of a long checkout path", () => {
    // Every path in a checkout is absolute and mostly cache bookkeeping.
    expect(
      describeEvent(tool("Read", { file_path: "/Users/j/.cerber/src/acme__widgets__42/web/src/Detail.tsx" })),
    ).toEqual(["reading web/src/Detail.tsx"]);
  });

  it("reports a search by what was searched for", () => {
    expect(describeEvent(tool("Grep", { pattern: "carryOverComments", path: "src" }))).toEqual([
      "searching for carryOverComments in src",
    ]);
  });

  it("reports a command by what it actually runs, not how it was described", () => {
    // A trusted review may run things; "ran the tests" is the model's framing,
    // the command is the fact.
    expect(
      describeEvent(tool("Bash", { command: "pnpm test", description: "Verify the fix" })),
    ).toEqual(["running pnpm test"]);
  });

  it("passes through what the run says between tools — that is the feedback", () => {
    expect(describeEvent(assistant({ type: "text", text: "Let me check whether refresh re-anchors." }))).toEqual([
      "Let me check whether refresh re-anchors.",
    ]);
  });

  it("never shows the JSON answer as progress", () => {
    // The reply lands rendered a second later; showing the raw object first
    // would put the machinery on screen.
    expect(describeEvent(assistant({ type: "text", text: '{"reply":"you are right",' }))).toEqual([]);
    expect(describeEvent(assistant({ type: "text", text: '```json\n{"reply":"x"}' }))).toEqual([]);
  });

  it("says it is thinking when that is all it is doing", () => {
    expect(describeEvent(assistant({ type: "thinking", thinking: "…" }))).toEqual(["thinking…"]);
  });

  it("reports a tool cerber refused it, rather than leaving a gap in the story", () => {
    expect(
      describeEvent({ type: "system", subtype: "permission_denied", tool_name: "Bash" } as ClaudeEvent),
    ).toEqual(["not allowed to use Bash"]);
  });

  it("ignores bookkeeping and anything it does not recognise", () => {
    expect(describeEvent({ type: "system", subtype: "init" } as ClaudeEvent)).toEqual([]);
    expect(describeEvent({ type: "result", result: "x" } as ClaudeEvent)).toEqual([]);
    expect(describeEvent({ type: "something_new_in_a_later_cli" } as ClaudeEvent)).toEqual([]);
    // Tool results are the raw material, not the story.
    expect(
      describeEvent({ type: "user", message: { content: [{ type: "tool_result" }] } } as ClaudeEvent),
    ).toEqual([]);
  });

  it("names an unknown tool rather than saying nothing", () => {
    expect(describeEvent(tool("SomeNewTool", {}))).toEqual(["using SomeNewTool"]);
  });

  it("clips a line that would take over the panel", () => {
    const line = describeEvent(assistant({ type: "text", text: "x".repeat(500) }))[0]!;
    expect(line.length).toBeLessThanOrEqual(180);
    expect(line.endsWith("…")).toBe(true);
  });

  it("collapses the newlines out of a multi-line command", () => {
    expect(describeEvent(tool("Bash", { command: "pnpm typecheck &&\n  pnpm test" }))).toEqual([
      "running pnpm typecheck && pnpm test",
    ]);
  });

  it("reports every block of one message, in order", () => {
    expect(
      describeEvent(
        assistant(
          { type: "text", text: "Checking the refresh path." },
          { type: "tool_use", name: "Read", input: { file_path: "a/b/refresh.ts" } },
        ),
      ),
    ).toEqual(["Checking the refresh path.", "reading a/b/refresh.ts"]);
  });
});
