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
 *
 * Two more things the pairing leaves behind are evened out on the way:
 * - a paired row is tinted amber/olive (`d2h-change`) and an unpaired one red
 *   or green, so one rewritten block came out in two colours. Every removal
 *   is red and every addition green, the way GitHub draws them.
 * - a pair is two lines that merely resemble each other most, and rewrapped
 *   prose resembles nothing in particular, so the word marks covered most of
 *   both lines and pointed at nothing. Where they cover more than half of a
 *   pair, they are dropped and the lines read as plain removal and addition.
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

/**
 * Word marks covering more of a pair than this, in more than one place per
 * line, say nothing about it. One edited word in a short line can cover half
 * of it too, but in one place; noise is scattered.
 */
const NOISY_MARKS = 0.5;
const NOISY_RUNS = 2;

const isPaired = (row: string) => /<td class="[^"]*\bd2h-change\b/.test(row);

/** The code text of a row and how much of it is marked, whitespace aside. */
function marked(row: string): { marked: number; runs: number; total: number } {
  const ctn = row.match(/<span class="d2h-code-line-ctn">([\s\S]*?)<\/span>\s*<\/div>/)?.[1] ?? "";
  const count = (s: string) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, "").length;
  const marks = [...ctn.matchAll(/<(ins|del)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => count(m[2]!));
  return { marked: marks.reduce((a, b) => a + b, 0), runs: marks.length, total: count(ctn) };
}

const unmark = (row: string) => row.replace(/<\/?(ins|del)\b[^>]*>/g, "");

const uncolour = (row: string) => row.replace(/\b(d2h-(?:del|ins)) d2h-change\b/g, "$1");

/**
 * diff2html prints a group of changed lines as all of its removals, then all
 * of its additions, and pairs the n-th of one with the n-th of the other. Its
 * matcher usually cuts a block into one-line groups, but not when a line runs
 * past 200 characters or the block is large — exactly a rewrapped paragraph —
 * so a pair is not necessarily two adjacent rows. Pairs are read off each
 * stretch of removals followed by additions, before the regrouping merges
 * those stretches.
 */
function quietNoisyPairs(rows: string[]): string[] {
  const out = [...rows];
  let dels: number[] = [];
  let inss: number[] = [];
  const settle = () => {
    for (let k = 0; k < Math.min(dels.length, inss.length); k++) {
      const [i, j] = [dels[k]!, inss[k]!];
      const [ma, mb] = [marked(out[i]!), marked(out[j]!)];
      const total = ma.total + mb.total;
      const noisy =
        total > 0 && (ma.marked + mb.marked) / total > NOISY_MARKS && ma.runs + mb.runs > NOISY_RUNS;
      if (noisy) {
        out[i] = unmark(out[i]!);
        out[j] = unmark(out[j]!);
      }
    }
    dels = [];
    inss = [];
  };
  rows.forEach((row, i) => {
    const kind = kindOf(row);
    // A removal after an addition, or any other row, starts a new stretch.
    if (kind !== "ins" && inss.length) settle();
    if (kind === "other") settle();
    else if (isPaired(row)) (kind === "del" ? dels : inss).push(i);
  });
  settle();
  return out.map(uncolour);
}

function regroup(body: string): string {
  // Code inside a row is escaped, so a literal `<tr>` or `</tr>` is markup.
  const found = body.match(/<tr>[\s\S]*?<\/tr>/g);
  if (!found) return body;
  const rows = quietNoisyPairs(found);
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

/** One file of the diff, as `splitDiffByFile` gives it. */
interface FilePatchLike {
  patch: string;
}

/**
 * Put back two things diff2html drops from what a file's patch says.
 *
 * - "\ No newline at end of file". diff2html strips the line before it parses,
 *   so a PR that only adds the missing newline showed `-end` over `+end` — the
 *   same line removed and added, for no reason anyone could see. The line it
 *   is about now says so beside itself.
 * - What a file with no hunks changed. diff2html calls every one of them "File
 *   without changes", which is false of a file whose mode changed (a script
 *   made executable) and vague about a rename.
 *
 * `files` is the diff split by file, in the order diff2html renders them; if
 * the two disagree on how many files there are, the diff is left as it came.
 */
export function describeFiles(html: string, files: FilePatchLike[]): string {
  const parts = html.split(/(?=<div id="[^"]*" class="d2h-file-wrapper")/);
  if (parts.length - 1 !== files.length) return html;
  return (
    parts[0]! +
    parts
      .slice(1)
      .map((part, i) => describeFile(part, files[i]!.patch))
      .join("")
  );
}

const NO_EOL = '<span class="no-eol" title="No newline at end of file">no newline at end of file</span>';

function describeFile(part: string, patch: string): string {
  const lines = patch.split("\n");
  const field = (re: RegExp) => lines.find((l) => re.test(l))?.match(re)?.[1];
  const oldMode = field(/^old mode (\d+)/);
  const newMode = field(/^new mode (\d+)/);
  const renamed = lines.some((l) => l.startsWith("rename to "));
  const without = renamed
    ? oldMode && newMode
      ? `File renamed, and its mode changed from ${oldMode} to ${newMode}`
      : "File renamed without changes"
    : oldMode && newMode
      ? `File mode changed from ${oldMode} to ${newMode}`
      : null;
  let out = without ? part.replace(/(\s*)File without changes(\s*)/, `$1${without}$2`) : part;

  for (const { kind, n } of missingNewlines(lines)) {
    out = out.replace(/<tr>[\s\S]*?<\/tr>/g, (row) => {
      const num = (k: 1 | 2) => row.match(new RegExp(`<div class="line-num${k}">\\s*(\\d*)\\s*</div>`))?.[1];
      const rowKind = kindOf(row);
      const hit =
        kind === "del"
          ? rowKind === "del" && num(1) === String(n)
          : kind === "ins"
            ? rowKind === "ins" && num(2) === String(n)
            : rowKind === "other" && num(2) === String(n);
      // After the text span rather than in it: syntax colouring reads the
      // span's text as the line's code.
      return hit && !row.includes('class="no-eol"')
        ? row.replace(/(<span class="d2h-code-line-ctn">[\s\S]*?<\/span>)(\s*<\/div>)/, `$1${NO_EOL}$2`)
        : row;
    });
  }
  return out;
}

/** The lines a "\ No newline at end of file" follows, by side and number. */
function missingNewlines(lines: string[]): { kind: Kind; n: number }[] {
  const found: { kind: Kind; n: number }[] = [];
  let oldN = 0;
  let newN = 0;
  let inHunk = false;
  let last: { kind: Kind; n: number } | null = null;
  for (const line of lines) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      [oldN, newN] = [Number(hunk[1]), Number(hunk[2])];
      inHunk = true;
      last = null;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\")) {
      if (last) found.push(last);
      continue;
    }
    if (line.startsWith("-")) last = { kind: "del", n: oldN++ };
    else if (line.startsWith("+")) last = { kind: "ins", n: newN++ };
    else if (line.startsWith(" ") || line === "") {
      last = { kind: "other", n: newN };
      oldN++;
      newN++;
    } else last = null;
  }
  return found;
}
