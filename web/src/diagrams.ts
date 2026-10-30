// `mermaid` code blocks in review prose, drawn where they stand. GitHub draws
// the same fence itself, so a diagram reads alike on both sides of a Send.
//
// Mermaid is large and few reviews have a diagram, so it loads only when one
// appears. The source is AI output about untrusted PR content: strict mode
// turns off its click handlers and scripts, and what it draws is sanitized like
// every other piece of prose here.

import DOMPurify from "dompurify";

let nextId = 0;

/** Replaces each diagram it can draw; one it can't stays visible as its source. */
export async function renderDiagrams(root: HTMLElement): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>("pre > code.language-mermaid")];
  if (blocks.length === 0) return;

  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    // A bad diagram stays as its source here, not as mermaid's bomb in <body>.
    suppressErrorRendering: true,
    theme: "neutral",
    // Plain SVG text: HTML labels need <foreignObject>, which the sanitizer drops.
    htmlLabels: false,
    // True size, scrolling if wider than the column: squeezed to fit, a long chain is unreadable.
    flowchart: { htmlLabels: false, useMaxWidth: false },
  });

  for (const code of blocks) {
    const source = code.textContent ?? "";
    try {
      const { svg } = await mermaid.render(`cerber-diagram-${++nextId}`, source);
      const pre = code.parentElement;
      // The text may have changed, or a second effect drawn it, while this ran.
      if (!pre?.isConnected) continue;
      const figure = document.createElement("figure");
      figure.className = "md-diagram";
      figure.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
      pre.replaceWith(figure);
    } catch (e) {
      console.warn("cerber: could not draw a diagram", e);
    }
  }
}
