import { Artifact } from "./artifact.js";

export interface AutoSendDecision {
  eligible: boolean;
  reason: string;
}

/**
 * Auto-send policy — deliberately narrow:
 * only APPROVE verdicts, at or above the confidence threshold, never a
 * re-send. COMMENT and REQUEST_CHANGES always wait for a human.
 */
export function evaluateAutoSend(artifact: Artifact, threshold: number): AutoSendDecision {
  if (artifact.sent) return { eligible: false, reason: "already sent" };
  if (artifact.status !== "ready") return { eligible: false, reason: `status is ${artifact.status}` };
  if (!artifact.verdict) return { eligible: false, reason: "no verdict" };
  if (artifact.verdict.recommendation !== "approve") {
    return {
      eligible: false,
      reason: `recommendation is ${artifact.verdict.recommendation} — only approve auto-sends`,
    };
  }
  // An approve verdict standing next to a live blocker finding contradicts
  // itself; a contradiction is a human's to resolve, never auto-sent.
  const blockers = artifact.comments.filter(
    (c) => c.status !== "dropped" && c.severity === "blocker",
  );
  if (blockers.length > 0) {
    return {
      eligible: false,
      reason: `verdict says approve but ${blockers.length} blocker finding(s) still stand — a human resolves that`,
    };
  }
  if (artifact.verdict.confidence < threshold) {
    return {
      eligible: false,
      reason: `confidence ${artifact.verdict.confidence}% < threshold ${threshold}%`,
    };
  }
  return { eligible: true, reason: `approve at ${artifact.verdict.confidence}% ≥ ${threshold}%` };
}
