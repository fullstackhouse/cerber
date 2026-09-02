import { marked } from "marked";
import { describe, expect, it } from "vitest";
import { readsAs, rendersDifferently } from "./Markdown";

/** The same parse the cockpit does, minus the sanitizer (which needs a DOM). */
const render = (text: string) => marked.parse(text, { async: false }) as string;
const worth = (text: string) => rendersDifferently(text, render(text));

describe("readsAs", () => {
  it("drops tags and flattens whitespace", () => {
    expect(readsAs("<p>hello <strong>there</strong></p>\n<p>again</p>")).toBe("hello there again");
  });

  it("puts entities back", () => {
    expect(readsAs("<p>a &amp; b &lt; c</p>")).toBe("a & b < c");
  });
});

describe("when a preview is worth drawing", () => {
  it("stays away from plain prose", () => {
    expect(worth("this reads fine as it is")).toBe(false);
  });

  it("stays away from paragraphs split by a blank line", () => {
    expect(worth("first thought\n\nsecond thought")).toBe(false);
  });

  it("stays away from an empty box", () => {
    expect(worth("")).toBe(false);
    expect(worth("   \n ")).toBe(false);
  });

  it("stays away from prose with an ampersand", () => {
    expect(worth("read & write")).toBe(false);
  });

  it("shows for a list", () => {
    expect(worth("- one\n- two")).toBe(true);
  });

  it("shows for a numbered list", () => {
    expect(worth("1. one\n2. two")).toBe(true);
  });

  it("shows for emphasis and inline code", () => {
    expect(worth("**really** important")).toBe(true);
    expect(worth("call `parseArgs` first")).toBe(true);
  });

  it("shows for a heading", () => {
    expect(worth("# the problem")).toBe(true);
  });

  it("shows for a link, whose target vanishes from the text", () => {
    expect(worth("see [the spec](https://example.com)")).toBe(true);
  });

  it("shows for a fenced code block", () => {
    expect(worth("```ts\nconst a = 1;\n```")).toBe(true);
  });

  it("shows for a blockquote", () => {
    expect(worth("> quoting you")).toBe(true);
  });

  it("shows for a graded comment, whose badge is markdown of its own", () => {
    expect(worth("🚨 **blocker** — this leaks")).toBe(true);
  });
});
