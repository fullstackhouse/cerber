import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useMemo, useRef } from "react";
import { renderDiagrams } from "./diagrams";

marked.setOptions({ gfm: true, breaks: false });

/** Markdown → sanitized HTML. One path, so a preview can't drift from the real render. */
export function renderMarkdown(text: string): string {
  const raw = marked.parse(text ?? "", { async: false }) as string;
  return DOMPurify.sanitize(raw);
}

/**
 * Draws the `mermaid` blocks of whatever `html` this ref's element holds. The
 * caller keeps its `{ __html }` object stable: a new one on a re-render makes
 * React rewrite the element, which would put the drawn diagrams back to source.
 */
function useDiagrams(html: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) void renderDiagrams(ref.current);
  }, [html]);
  return ref;
}

/** Render trusted-ish markdown (AI output / PR content) safely. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const rendered = useMemo(() => ({ __html: renderMarkdown(text) }), [text]);
  const ref = useDiagrams(rendered.__html);
  if (!text?.trim()) return null;
  return <div ref={ref} className={`md ${className ?? ""}`} dangerouslySetInnerHTML={rendered} />;
}

const ENTITY: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/**
 * What a rendered block reads as: tags dropped, entities back to characters,
 * whitespace runs flattened. Deliberately not DOM-based — this decides whether
 * to draw a preview, and that decision is worth a test that runs without a
 * browser.
 */
export function readsAs(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&([a-z]+|#\d+);/gi, (m, name: string) => ENTITY[name.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Would this render as something other than what was typed?
 *
 * The rule the preview turns on: markdown that reads back word-for-word as its
 * own source — a one-line note, a plain paragraph, a blank-line-separated pair
 * of them — is told nothing by a second copy of itself underneath the box. A
 * list, a heading, `code`, **bold**, a [link] all lose or move characters on
 * the way through, and those are exactly the drafts worth seeing first.
 */
export function rendersDifferently(text: string, html: string): boolean {
  return readsAs(html) !== text.replace(/\s+/g, " ").trim();
}

/**
 * A draft as it will read once posted — under the box you are typing it in.
 *
 * It costs no click and has no switch: it appears when it has something to
 * say and stays out of the way when it doesn't. Comment bodies are sent to
 * GitHub as markdown, so "what did I actually write" is a question the cockpit
 * should answer before the Send, not after.
 */
export function MarkdownPreview({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => ({ __html: text?.trim() ? renderMarkdown(text) : "" }), [text]);
  const ref = useDiagrams(html.__html);
  if (!html.__html || !rendersDifferently(text, html.__html)) return null;
  return (
    <div className="md-preview">
      <div className="lab">preview</div>
      <div ref={ref} className={`md prose ${className ?? ""}`} dangerouslySetInnerHTML={html} />
    </div>
  );
}
