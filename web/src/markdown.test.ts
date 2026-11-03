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

describe("renderMarkdown and diagrams", () => {
  it("keeps the class a mermaid block is found by", () => {
    expect(render("```mermaid\nflowchart LR\n  A --> B\n```")).toContain('class="language-mermaid"');
  });
});

describe("GitHub alerts", () => {
  it("draws a warning as an alert, not as a quote with its marker showing", () => {
    const html = render("> [!WARNING]\n> **Run the check first.** The migration fails otherwise.");
    expect(html).toContain('class="md-alert md-alert-warning"');
    expect(html).toContain('<p class="md-alert-title">Warning</p>');
    expect(html).toContain("<p><strong>Run the check first.</strong> The migration fails otherwise.</p>");
    expect(html).not.toContain("[!WARNING]");
    expect(html).not.toContain("<blockquote>");
  });

  it("keeps a list that follows the marker", () => {
    const html = render("> [!CAUTION]\n>\n> - one\n> - two");
    expect(html).toContain("md-alert-caution");
    expect(html).toMatch(/<\/p>\n<ul>\n<li>one<\/li>/);
    expect(html).not.toContain("[!CAUTION]");
  });

  it("leaves an ordinary quote a quote", () => {
    expect(render("> quoting you")).toBe("<blockquote>\n<p>quoting you</p>\n</blockquote>\n");
    expect(render("> [!SHOUT] not a kind GitHub knows")).toContain("<blockquote>");
  });

  it("leaves an escaped marker as the literal text it asks for", () => {
    const html = render("> \\[!WARNING]\n> literal");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("[!WARNING]");
    expect(html).not.toContain("md-alert");
  });

  it("renders nested quotes in work linear in their depth", () => {
    const parse = marked.Parser.prototype.parse;
    let calls = 0;
    marked.Parser.prototype.parse = function (...args: Parameters<typeof parse>) {
      calls++;
      return parse.apply(this, args);
    };
    try {
      const html = render(">".repeat(12) + " deep");
      expect(html.match(/<blockquote>/g)).toHaveLength(12);
      expect(calls).toBeLessThan(30);
    } finally {
      marked.Parser.prototype.parse = parse;
    }
  });
});
