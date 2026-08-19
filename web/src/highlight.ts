import { mergeStreams, nodeStream, getLanguage } from "diff2html/lib-esm/ui/js/highlight.js-helpers";
import hljs from "highlight.js/lib/common";

/**
 * Extensions diff2html's own table doesn't map, or maps to a language the
 * common highlight.js bundle doesn't ship. Anything still unknown stays
 * uncoloured rather than being force-fit into the wrong grammar.
 */
const extraLanguages: Record<string, string> = {
  cjs: "javascript",
  cts: "typescript",
  mts: "typescript",
  toml: "ini",
  svelte: "xml",
  vue: "xml",
  htm: "xml",
  zsh: "bash",
  fish: "bash",
};

/** Beyond this a hunk side is left uncoloured — minified bundles, lockfiles. */
const maxHunkChars = 200_000;

const xhtml = "http://www.w3.org/1999/xhtml";

type LineKind = "ins" | "del" | "cntx";
interface DiffLine {
  kind: LineKind;
  ctn: HTMLElement;
}

/**
 * Syntax-colour a rendered diff2html tree in place. The language comes from the
 * file's extension (diff2html leaves it on `data-lang`).
 */
export function highlightDiff(root: HTMLElement): void {
  for (const file of root.querySelectorAll<HTMLElement>(".d2h-file-wrapper")) {
    const language = languageFor(file.dataset.lang ?? "");
    if (!language) continue;
    for (const hunk of hunks(file)) {
      // Each side is highlighted as one document so that block comments and
      // template literals keep their state across lines. Context lines take
      // their colours from the new side; the old side only paints deletions.
      highlightSide(
        hunk.filter((l) => l.kind !== "ins"),
        (l) => l.kind === "del",
        language,
      );
      highlightSide(
        hunk.filter((l) => l.kind !== "del"),
        () => true,
        language,
      );
    }
  }
}

function languageFor(extension: string): string | null {
  const language = extraLanguages[extension] ?? getLanguage(extension);
  if (language === "plaintext" || !hljs.getLanguage(language)) return null;
  return language;
}

/**
 * The file's code lines, split at hunk boundaries: the gap between hunks is
 * unknown code, so highlighter state must not carry across it.
 */
function hunks(file: HTMLElement): DiffLine[][] {
  const result: DiffLine[][] = [];
  let current: DiffLine[] = [];
  for (const row of file.querySelectorAll<HTMLElement>(".d2h-diff-tbody > tr")) {
    const cell = row.querySelector<HTMLElement>("td:last-child");
    const ctn = cell?.querySelector<HTMLElement>(".d2h-code-line-ctn");
    if (!cell || !ctn) {
      // Hunk header, "file not shown", or an injected comment row.
      if (current.length) result.push(current);
      current = [];
      continue;
    }
    const kind: LineKind = cell.classList.contains("d2h-ins")
      ? "ins"
      : cell.classList.contains("d2h-del")
        ? "del"
        : "cntx";
    current.push({ kind, ctn });
  }
  if (current.length) result.push(current);
  return result;
}

function highlightSide(
  lines: DiffLine[],
  apply: (line: DiffLine) => boolean,
  language: string,
): void {
  const targets = lines.filter(apply);
  if (targets.length === 0) return;

  const text = lines.map((l) => l.ctn.textContent ?? "").join("\n");
  if (!text.trim() || text.length > maxHunkChars) return;

  const highlighted = splitLines(hljs.highlight(text, { language, ignoreIllegals: true }).value);
  lines.forEach((line, i) => {
    const value = highlighted[i];
    if (value === undefined || !apply(line)) return;
    paint(line.ctn, value);
  });
}

/**
 * Replace a line's markup with its highlighted version. diff2html marks
 * intra-line changes with <ins>/<del> inside the line, which highlight.js never
 * saw, so the two token streams are merged back together.
 */
function paint(ctn: HTMLElement, value: string): void {
  const original = nodeStream(ctn);
  let merged = value;
  if (original.length) {
    const node = document.createElementNS(xhtml, "div");
    node.innerHTML = value;
    merged = mergeStreams(original, nodeStream(node), ctn.textContent ?? "");
  }
  ctn.classList.add("hljs");
  ctn.innerHTML = merged;
}

/**
 * Cut multi-line highlighted markup into one self-contained string per line,
 * closing the open spans at every break and reopening them on the next line.
 */
function splitLines(value: string): string[] {
  const root = document.createElementNS(xhtml, "div");
  root.innerHTML = value;

  const lines: string[] = [];
  const open: string[] = [];
  let current = "";

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parts = (node.textContent ?? "").split("\n");
      parts.forEach((part, i) => {
        if (i > 0) {
          current += "</span>".repeat(open.length);
          lines.push(current);
          current = open.join("");
        }
        current += escapeHtml(part);
      });
      return;
    }
    // highlight.js only ever emits <span class="…"> wrappers.
    const tag = `<span class="${(node as HTMLElement).className}">`;
    current += tag;
    open.push(tag);
    node.childNodes.forEach(walk);
    open.pop();
    current += "</span>";
  };

  root.childNodes.forEach(walk);
  lines.push(current);
  return lines;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
