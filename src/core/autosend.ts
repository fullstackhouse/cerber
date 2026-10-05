import { Artifact } from "./artifact.js";
import { sendTreatment } from "./raised.js";

export interface AutoSendDecision {
  eligible: boolean;
  reason: string;
}

/**
 * Auto-send policy — deliberately narrow:
 * only APPROVE verdicts, at or above the confidence threshold, never a
 * re-send. COMMENT and REQUEST_CHANGES always wait for a human.
 *
 * Findings somebody else already raised go the way Send's default sends them:
 * an undecided one is left out, and the reason says how many were. Nobody is
 * there to decide, and the default is the side that posts less. A reply into
 * someone's thread is never auto-sent — that is a decision only a person makes,
 * and auto-send posts one review and nothing else.
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
  // Nobody is watching an auto-send, so a check that never ran is not the same
  // as one that found nothing: it would post every duplicate it missed.
  if (artifact.raisedCheck?.error) {
    return {
      eligible: false,
      reason: `could not check which findings other reviewers already raised (${artifact.raisedCheck.error})`,
    };
  }
  const live = artifact.comments.filter((c) => c.status !== "dropped");
  const replies = live.filter((c) => sendTreatment(c) === "reply").length;
  if (replies > 0) {
    return {
      eligible: false,
      reason: `${replies} finding(s) marked to reply in another reviewer's thread — only a human Send posts replies`,
    };
  }
  const held = live.filter((c) => sendTreatment(c) === "hold").length;
  return {
    eligible: true,
    reason:
      `approve at ${artifact.verdict.confidence}% ≥ ${threshold}%` +
      (held > 0 ? `; ${held} finding(s) already raised by another reviewer left out` : ""),
  };
}
