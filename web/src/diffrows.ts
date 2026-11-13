/**
 * Lay each change out the way GitHub does: every removed line of a run, then
 * every added one.
 *
 * diff2html's line matching pairs each removed line with the added line it
 * most resembles — which is what lets it mark the changed words — but it then
 * prints the pairs one after another, so a rewritten paragraph reads as
 * `- + - + - +`, and neither the old text nor the new can be read through.
 * This keeps the pairing (the word marks are already in the rows) and only
 * reorders the rows: within each unbroken run of changed lines, removals
 * first, additions after, each side in its own order.
 */
export function groupChangedRows(html: string): string {
  return html.replace(
    /(<tbody class="d2h-diff-tbody">)([\s\S]*?)(<\/tbody>)/g,
    (_, open: string, body: string, close: string) => open + regroup(body) + close,
  );
}

type Kind = "del" | "ins" | "other";

function kindOf(row: string): Kind {
  // The first cell is the line-number cell, and it carries the row's class.
  const cls = row.match(/<td class="([^"]*)"/)?.[1] ?? "";
  const classes = cls.split(/\s+/);
  if (classes.includes("d2h-del")) return "del";
  if (classes.includes("d2h-ins")) return "ins";
  return "other";
}

function regroup(body: string): string {
  // Code inside a row is escaped, so a literal `<tr>` or `</tr>` is markup.
  const rows = body.match(/<tr>[\s\S]*?<\/tr>/g);
  if (!rows) return body;
  const lead = body.slice(0, body.indexOf("<tr>"));
  const tail = body.slice(body.lastIndexOf("</tr>") + "</tr>".length);
  const out: string[] = [];
  let dels: string[] = [];
  let inss: string[] = [];
  const flush = () => {
    out.push(...dels, ...inss);
    dels = [];
    inss = [];
  };
  for (const row of rows) {
    const kind = kindOf(row);
    if (kind === "del") dels.push(row);
    else if (kind === "ins") inss.push(row);
    else {
      flush();
      out.push(row);
    }
  }
  flush();
  return lead + out.join("") + tail;
}
