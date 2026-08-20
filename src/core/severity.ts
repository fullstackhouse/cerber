import type { Severity } from "./artifact.js";

/**
 * One badge per grade. A reader skimming twenty inline comments on GitHub gets
 * no chips and no colour — the grade has to be legible in the text itself, and
 * an emoji is what survives GitHub's markdown.
 */
export const SEVERITY_BADGE: Record<Severity, string> = {
  blocker: "🚨",
  minor: "⚠️",
  nit: "🎨",
};

/**
 * Prefix a comment body with its grade — in the cockpit, on GitHub and in the
 * export alike, so a comment reads the same wherever it is read. It is applied
 * at render time and never stored: `severity` stays the one place a grade
 * lives, and the body the user edits is the body that gets sent.
 *
 * To a reader used to review convention, an unprefixed comment says "please
 * change this", so leaving a nit bare would invert its meaning. Ungraded
 * remarks (questions, notes) stay bare — they are not findings, and badging
 * them would make them look like ones.
 */
export function withGrade(body: string, severity: Severity | null): string {
  if (!severity) return body;
  return `${SEVERITY_BADGE[severity]} **${severity}** — ${body}`;
}
