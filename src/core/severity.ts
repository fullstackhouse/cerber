import type { Severity } from "./artifact.js";

/**
 * One badge per grade, used everywhere a finding is shown: the cockpit's chip,
 * the GitHub comment body, the markdown export. A reader skimming twenty inline
 * comments on GitHub gets no chips and no colour — the grade has to be legible
 * in the text itself, and an emoji is what survives GitHub's markdown.
 */
export const SEVERITY_BADGE: Record<Severity, string> = {
  blocker: "🚨",
  minor: "⚠️",
  nit: "🎨",
};

/** "🚨 blocker" — the chip label in the cockpit. */
export function severityBadge(severity: Severity): string {
  return `${SEVERITY_BADGE[severity]} ${severity}`;
}

/**
 * Prefix a comment body with its grade.
 *
 * The grade travels in the text: to a reader used to review convention, an
 * unprefixed comment says "please change this", so leaving a nit bare would
 * invert its meaning. Ungraded remarks (questions, notes) stay bare — they are
 * not findings, and badging them would make them look like ones.
 */
export function withGrade(body: string, severity: Severity | null): string {
  if (!severity) return body;
  return `${SEVERITY_BADGE[severity]} **${severity}** — ${body}`;
}
