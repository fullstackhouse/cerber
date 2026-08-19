import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import {
  AiChatTurnSchema,
  Artifact,
  ChatTurn,
  Refusal,
  Revision,
} from "../core/artifact.js";
import { createRunDir, prepareCheckout, removeRunDir, sourceDir } from "../core/checkout.js";
import { PrRef } from "../core/gh.js";
import { applyRevisions, snapshotReview } from "../core/revise.js";
import { extractJson, runClaude, unauthenticatedEnv } from "./claude.js";
import { beginReview, endReview } from "./inflight.js";
import { buildChatPrompt } from "./prompt.js";

/**
 * One turn of a conversation about a drafted review.
 *
 * The turn resumes the review's own Claude session where it can, so the model
 * answering "did you actually check that?" is the one that did or didn't. The
 * agent revises the draft directly — no accept step — because the user asked
 * for the change and asking again would be friction wearing safety's coat.
 *
 * Everything a review run is denied, a chat turn is denied identically: it has
 * no GitHub credentials, treats the checkout as untrusted content, and never
 * gets Edit or Write. It is one step from the only path that writes to GitHub,
 * so the isolation is the same isolation.
 */

/** All an untrusted turn needs from a checkout — everything else stays off. */
const READ_TOOLS = ["Read", "Grep", "Glob"];
const OFF_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "Task", "WebFetch", "WebSearch"];
const TRUSTED_TOOLS = [...READ_TOOLS, "Bash", "WebFetch", "WebSearch"];
const TRUSTED_OFF_TOOLS = ["Edit", "Write", "NotebookEdit"];

export interface ChatSource {
  /** The readable checkout, or null when we could not produce one. */
  dir: string | null;
  /** What the checkout is at, when we have one. */
  sha: string | null;
  /** True when this turn had to re-clone an evicted checkout. */
  recloned: boolean;
}

/**
 * Put the reviewed source back under the chat turn, or say plainly that we
 * could not.
 *
 * The checkout cache is small and evicts by least-recent use, so by the time
 * someone argues with a review its source is often already gone. That matters
 * more here than anywhere else: the turn resumes a session whose transcript
 * still describes files it read, and Claude sessions are keyed by working
 * directory. Resuming into a deleted one leaves a model that believes it can
 * open the file and will otherwise describe it from memory.
 *
 * `prepareCheckout` is idempotent and restores the same deterministic path, so
 * re-cloning is enough to make resume whole again. It also touches the
 * directory, which is what keeps a checkout alive through a long conversation:
 * eviction is by mtime, so every turn renews it.
 */
export async function ensureChatSource(
  artifact: Artifact,
  opts: { log?: (message: string) => void; prepare?: typeof prepareCheckout } = {},
): Promise<ChatSource> {
  const log = opts.log ?? (() => {});
  const prepare = opts.prepare ?? prepareCheckout;
  // A review that never had a checkout has nothing to restore, and re-cloning
  // now would give the conversation context the review itself never had.
  if (!artifact.run?.withSource) return { dir: null, sha: null, recloned: false };

  const ref: PrRef = {
    owner: artifact.pr.owner,
    repo: artifact.pr.repo,
    number: artifact.pr.number,
  };
  const existed = await isCheckedOut(sourceDir(ref));
  try {
    // The same trust the review ran under: a checkout prepared as trusted keeps
    // the PR's own CLAUDE.md in place, and re-preparing with the wrong flag
    // would either un-quarantine it or quarantine what the review could read.
    const checkout = await prepare(ref, { log, trusted: artifact.run.trusted });
    if (!existed) log("The checkout had been evicted — re-cloned it so this turn can read the code.");
    return { dir: checkout.dir, sha: checkout.sha, recloned: !existed };
  } catch (err: unknown) {
    log(
      `Could not restore the source (${err instanceof Error ? err.message : err}) — ` +
        `this turn works from the review, the diff and the conversation alone.`,
    );
    return { dir: null, sha: null, recloned: false };
  }
}

async function isCheckedOut(dir: string): Promise<boolean> {
  return fs
    .stat(dir)
    .then((s) => s.isDirectory())
    .catch(() => false);
}

export interface ChatTurnOptions {
  model?: string;
  /** What the user pointed at with "discuss this". */
  refs?: ChatTurn["refs"];
  /**
   * Path to the readable checkout. Omit to let the turn restore it itself —
   * which is what the cockpit does, since the cache will usually have evicted
   * it by the time anyone argues with the review. Pass null to force a turn
   * that reads nothing.
   */
  source?: string | null;
  /** The commit the checkout is at, when the caller supplied one. */
  sourceSha?: string | null;
  /** The user vouched for this PR, so the turn may also run commands. */
  trusted?: boolean;
  /** Let this turn rewrite comments the user wrote — only on their say-so. */
  allowUserComments?: boolean;
  onProgress?: (message: string) => void;
  /** Injected for tests. */
  now?: () => string;
  newId?: () => string;
  run?: typeof runClaude;
}

export interface ChatTurnResult {
  artifact: Artifact;
  applied: Revision[];
  refused: Refusal[];
}

/**
 * Append the user's message and the reviewer's answer, applying whatever the
 * answer revised. Claims the artifact's inflight slot for the duration: the
 * daemon's timer and the cockpit's re-review button write the same file.
 */
export async function runChatTurn(
  artifact: Artifact,
  message: string,
  opts: ChatTurnOptions = {},
): Promise<ChatTurnResult> {
  beginReview(artifact.id);
  try {
    return await turn(artifact, message, opts);
  } finally {
    endReview(artifact.id);
  }
}

async function turn(
  artifact: Artifact,
  message: string,
  opts: ChatTurnOptions,
): Promise<ChatTurnResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const newId = opts.newId ?? randomUUID;
  const run = opts.run ?? runClaude;
  const log = opts.onProgress ?? (() => {});

  // Restore the checkout unless the caller already resolved one (or asked for
  // none). Doing it here, rather than making the cockpit remember, is what
  // stops "the cache evicted it" from silently degrading every later turn.
  const resolved =
    opts.source === undefined
      ? await ensureChatSource(artifact, { log })
      : { dir: opts.source, sha: opts.sourceSha ?? null, recloned: false };
  const source = resolved.dir;
  const trusted = (opts.trusted ?? artifact.run?.trusted ?? false) && source !== null;

  // A re-cloned checkout follows the PR, not the review: if the author pushed
  // since, the files under the model are newer than the draft it is defending.
  const moved =
    source !== null && resolved.sha !== null && artifact.pr.headSha !== "" && resolved.sha !== artifact.pr.headSha
      ? `Note: the review was written against ${artifact.pr.headSha.slice(0, 7)}, but the checkout is now at ${resolved.sha.slice(0, 7)} — the author has pushed since. Code you read may not be the code the review is about; say so when it matters.`
      : undefined;
  if (moved) log(moved);

  // The session is only worth resuming into the directory it was created in.
  // Without the checkout the transcript survives but Read and Grep do not, and
  // a model that thinks it can still open the file will describe code from
  // memory — worse than one that knows it is working blind.
  const resumeSessionId = source && artifact.run?.sessionId ? artifact.run.sessionId : undefined;
  if (artifact.run?.sessionId && !source) {
    log("The checkout is gone — this turn works from the review, the diff and the conversation.");
  }

  const { prompt } = buildChatPrompt(artifact, message, {
    refs: opts.refs,
    source: source !== null,
    trusted,
    resumed: Boolean(resumeSessionId),
    sourceNote: moved,
  });

  const empty = await createRunDir();
  const claudeOpts = {
    model: opts.model,
    cwd: source ?? empty,
    env: unauthenticatedEnv(process.env, empty),
    allowedTools: source ? (trusted ? TRUSTED_TOOLS : READ_TOOLS) : undefined,
    disallowedTools: source
      ? trusted
        ? TRUSTED_OFF_TOOLS
        : OFF_TOOLS
      : [...OFF_TOOLS, ...READ_TOOLS],
    isolateWorkspace: !(source && trusted),
    resumeSessionId,
  };

  let reply: { reply: string; revisions: Revision[] };
  let costUsd: number | null;
  let sessionId: string | null;
  try {
    const first = await run(prompt, claudeOpts);
    try {
      reply = AiChatTurnSchema.parse(extractJson(first.text));
      costUsd = first.costUsd;
      sessionId = first.sessionId;
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      log("Model output failed validation — retrying once…");
      // Resume the turn we just had rather than the review: the retry is about
      // the JSON shape, and re-sending the whole prompt would say it all twice.
      const second = await run(retryPrompt(first.text, detail), {
        ...claudeOpts,
        resumeSessionId: first.sessionId ?? resumeSessionId,
      });
      reply = AiChatTurnSchema.parse(extractJson(second.text));
      const total = (first.costUsd ?? 0) + (second.costUsd ?? 0);
      costUsd = total > 0 ? total : null;
      sessionId = second.sessionId ?? first.sessionId;
    }
  } finally {
    await removeRunDir(empty);
  }

  // The first turn snapshots the review, so "reset" always has somewhere to go
  // back to. Later turns leave that snapshot alone: it is the pre-chat draft,
  // not the previous turn's.
  const at = now();
  const preChat = artifact.preChat ?? snapshotReview(artifact, at);

  const userTurn: ChatTurn = {
    id: newId(),
    role: "user",
    at,
    body: message,
    refs: opts.refs ?? [],
    revisions: [],
    refused: [],
    costUsd: null,
  };

  const revised = applyRevisions(artifact, reply.revisions, {
    newId,
    allowUserComments: opts.allowUserComments,
  });

  const assistantTurn: ChatTurn = {
    id: newId(),
    role: "assistant",
    at: now(),
    body: reply.reply,
    refs: [],
    revisions: revised.applied,
    refused: revised.refused,
    costUsd,
  };

  return {
    artifact: {
      ...revised.artifact,
      updatedAt: assistantTurn.at,
      preChat,
      chat: [...artifact.chat, userTurn, assistantTurn],
      run: artifact.run ? { ...artifact.run, sessionId: sessionId ?? artifact.run.sessionId } : null,
    },
    applied: revised.applied,
    refused: revised.refused,
  };
}

function retryPrompt(badOutput: string, error: string): string {
  return `Your previous response could not be parsed as the required JSON.
Error: ${error}
Previous response (truncated): ${badOutput.slice(0, 2_000)}

Respond again with ONLY the valid JSON object described earlier: an object with "reply" and "revisions".`;
}
