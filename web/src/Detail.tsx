import { html } from "diff2html";
import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { patchForFiles, unclaimedFiles } from "../../src/core/diff";
import { withGrade } from "../../src/core/severity";
import {
  addComment,
  deleteComment,
  dismissPendingChat,
  exportUrl,
  fetchReview,
  fetchReviews,
  fetchSendPreview,
  patchComment,
  patchReview,
  refreshReview,
  rerunReview,
  resetReviewToPreChat,
  sendReview,
  startChatTurn,
} from "./api";
import { highlightDiff } from "./highlight";
import { Icon, IconName, Key } from "./Icon";
import { Markdown } from "./Markdown";
import { walkable } from "./inbox";
import {
  EVENT_LABEL,
  EVENT_TONE,
  ReviewEvent,
  eventForVerdict,
  inlineComments,
  payloadSummary,
  severitySummary,
  splitComments,
  verdictMismatch,
} from "./review";
import {
  Artifact,
  Chapter,
  ChatRef,
  ChatTurn,
  RefreshResult,
  Revision,
  ReviewComment,
  ReviewListItem,
  SendPreview,
  Verdict,
} from "./types";

const TONE: Record<Verdict["recommendation"], "approve" | "comment" | "changes"> = {
  approve: "approve",
  comment: "comment",
  request_changes: "changes",
};

const VERDICT_ICON: Record<Verdict["recommendation"], IconName> = {
  approve: "approve",
  comment: "comment",
  request_changes: "changes",
};

/** What a comment's dot in the rail says about it at a glance. */
function commentTone(c: ReviewComment, verdictTone: string): string {
  if (c.status === "dropped") return "none";
  if (c.drifted) return "comment";
  if (c.origin === "user") return "awaiting";
  return verdictTone;
}

/**
 * Jump to a comment that may not be in the DOM yet — its chapter might have
 * been collapsed, and the diff it lives in mounts a frame or two later.
 */
function scrollToComment(id: string, tries = 20): void {
  const el = document.getElementById(`c-${id}`);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (tries > 0) requestAnimationFrame(() => scrollToComment(id, tries - 1));
}

/** True while the user is typing — keyboard shortcuts stay out of the way. */
function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  const tag = el?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable === true;
}

/**
 * Diff rendered by diff2html, with review comments injected inline under the
 * diff row they point at (like the GitHub PR view). Comments whose row can't
 * be found in the rendered HTML fall back to normal cards below the diff.
 */
function DiffBlock({
  patch,
  comments,
  renderComment,
}: {
  patch: string;
  comments: ReviewComment[];
  renderComment: (c: ReviewComment) => ReactNode;
}) {
  const rendered = useMemo(
    () =>
      patch.trim()
        ? html(patch, { drawFileList: false, matching: "lines", outputFormat: "line-by-line" })
        : "",
    [patch],
  );
  const ref = useRef<HTMLDivElement>(null);
  const [slots, setSlots] = useState<{ id: string; el: HTMLElement }[]>([]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.innerHTML = rendered;
    highlightDiff(root);

    const byFile = new Map<string, Element>();
    for (const wrapper of root.querySelectorAll(".d2h-file-wrapper")) {
      const name = wrapper.querySelector(".d2h-file-name")?.textContent?.trim();
      if (name) byFile.set(name, wrapper);
    }

    const placed: { id: string; el: HTMLElement }[] = [];
    // When several comments target the same line, insert each after the last.
    const anchors = new Map<Element, Element>();
    for (const c of comments) {
      if (c.line == null) continue;
      const wrapper = byFile.get(c.path);
      if (!wrapper) continue;
      const row = Array.from(wrapper.querySelectorAll(".d2h-diff-tbody > tr")).find(
        (tr) => tr.querySelector(".line-num2")?.textContent?.trim() === String(c.line),
      );
      if (!row) continue;
      const tr = document.createElement("tr");
      tr.className = "inline-comment-row";
      const td = document.createElement("td");
      td.colSpan = 2;
      const holder = document.createElement("div");
      td.appendChild(holder);
      tr.appendChild(td);
      (anchors.get(row) ?? row).after(tr);
      anchors.set(row, tr);
      placed.push({ id: c.id, el: holder });
    }
    setSlots(placed);
  }, [rendered, comments]);

  if (!rendered) return <p className="muted">No diff for this chapter.</p>;
  const unplaced = comments.filter((c) => !slots.some((s) => s.id === c.id));
  return (
    <>
      <div className="diff" ref={ref} />
      {slots.map(({ id, el }) => {
        const c = comments.find((x) => x.id === id);
        return c ? createPortal(renderComment(c), el, id) : null;
      })}
      {unplaced.map((c) => renderComment(c))}
    </>
  );
}

function CommentCard({
  comment,
  onUpdate,
  onDelete,
  onDiscuss,
  readOnly,
  flash,
}: {
  comment: ReviewComment;
  onUpdate: (patch: { body?: string; status?: string }) => void;
  onDelete: () => void;
  onDiscuss?: () => void;
  readOnly: boolean;
  /** Just jumped to from the rail — say so, or it lands invisibly mid-diff. */
  flash?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);

  const kept = comment.status === "approved";
  const dropped = comment.status === "dropped";
  const tag = comment.origin === "user" ? "yours" : dropped ? "dropped" : kept ? "kept" : "drafted";

  return (
    <div id={`c-${comment.id}`} className={`comment comment-${comment.status}${flash ? " comment-flash" : ""}`}>
      <div className="comment-head">
        <span className="comment-loc">
          {comment.path}
          {comment.line != null ? `:${comment.line}` : ""}
        </span>
        <span className={`tag tag-${comment.origin === "user" ? "yours" : tag}`}>{tag}</span>
        {comment.drifted && (
          <span
            className="tag tag-drift"
            title="The code this comment pointed at is gone from the diff, so it can't post inline."
          >
            drifted — posts in the body
          </span>
        )}
        {!comment.drifted && comment.originalLine != null && comment.originalLine !== comment.line && (
          <span className="faint" title="This comment followed its code to a new line.">
            was :{comment.originalLine}
          </span>
        )}
        <span className="grow" />
        {!readOnly &&
          (editing ? (
            <>
              <button
                className="btn btn-sm"
                onClick={() => {
                  onUpdate({ body: draft });
                  setEditing(false);
                }}
              >
                save
              </button>
              <button
                className="btn btn-sm"
                onClick={() => {
                  setDraft(comment.body);
                  setEditing(false);
                }}
              >
                cancel
              </button>
            </>
          ) : (
            <>
              <button
                className={`btn btn-sm${kept ? " btn-keep-on" : ""}`}
                title="Keep this comment — it posts with the review"
                onClick={() => onUpdate({ status: kept ? "draft" : "approved" })}
              >
                <Icon name="check" />
                keep
              </button>
              <button className="btn btn-sm" title="Edit the wording" onClick={() => setEditing(true)}>
                <Icon name="edit" />
                edit
              </button>
              <button
                className={`btn btn-sm${dropped ? " btn-drop-on" : ""}`}
                title="Drop it — stays local, never posts"
                onClick={() => onUpdate({ status: dropped ? "draft" : "dropped" })}
              >
                <Icon name="drop" />
                {dropped ? "dropped" : "drop"}
              </button>
              {onDiscuss && (
                <button
                  className="btn btn-sm btn-accent"
                  title="Point the chat at this comment"
                  onClick={onDiscuss}
                >
                  <Icon name="comment" />
                  discuss
                </button>
              )}
              {comment.origin === "user" && (
                <button className="btn btn-sm" title="Delete the comment you wrote" onClick={onDelete}>
                  ✕
                </button>
              )}
            </>
          ))}
      </div>
      {editing ? (
        <textarea
          className="comment-edit"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.max(3, draft.split("\n").length)}
        />
      ) : (
        // The grade reads as the first words of the comment, exactly as it will
        // on GitHub — not as a chip that only exists here. Prefixed at render
        // time from `severity`, so the body being edited stays the body sent.
        <Markdown className="comment-body prose" text={withGrade(comment.body, comment.severity ?? null)} />
      )}
    </div>
  );
}

function AddComment({
  files,
  chapterId,
  onAdd,
}: {
  files: string[];
  chapterId: string | null;
  onAdd: (c: { path: string; line: number | null; body: string; chapterId: string | null }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState(files[0] ?? "");
  const [line, setLine] = useState("");
  const [body, setBody] = useState("");

  if (!open)
    return (
      <button className="btn btn-dashed" onClick={() => setOpen(true)}>
        <Icon name="plus" />
        add a comment of your own
      </button>
    );

  return (
    <div className="add-comment">
      <div className="add-comment-row">
        <select value={path} onChange={(e) => setPath(e.target.value)}>
          {files.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <input
          placeholder="line (optional)"
          value={line}
          onChange={(e) => setLine(e.target.value.replace(/\D/g, ""))}
          size={12}
        />
      </div>
      <textarea placeholder="Your comment…" value={body} onChange={(e) => setBody(e.target.value)} rows={3} />
      <div className="add-comment-row">
        <button
          className="btn"
          disabled={!body.trim() || !path}
          onClick={() => {
            onAdd({ path, line: line ? Number(line) : null, body: body.trim(), chapterId });
            setBody("");
            setLine("");
            setOpen(false);
          }}
        >
          add
        </button>
        <button className="btn" onClick={() => setOpen(false)}>
          cancel
        </button>
      </div>
    </div>
  );
}

function ChapterSection({
  chapter,
  n,
  diff,
  comments,
  open,
  onToggle,
  onUpdateComment,
  onDeleteComment,
  onAddComment,
  onDiscuss,
  readOnly,
  anchorRef,
  flash,
}: {
  chapter: Chapter;
  n: number;
  diff: string;
  comments: ReviewComment[];
  open: boolean;
  onToggle: () => void;
  flash: string | null;
  onUpdateComment: (id: string, patch: { body?: string; status?: string }) => void;
  onDeleteComment: (id: string) => void;
  onAddComment: (c: { path: string; line: number | null; body: string; chapterId: string | null }) => void;
  onDiscuss?: (ref: ChatRef) => void;
  readOnly: boolean;
  anchorRef: (el: HTMLElement | null) => void;
}) {
  const patch = useMemo(() => patchForFiles(diff, chapter.files), [diff, chapter.files]);
  // Comments that can be anchored render inline under the line they point at
  // (like GitHub); the rest — off-diff, or drifted — render as cards above it,
  // which is also where they will end up in the review body.
  const inline = useMemo(() => inlineComments(patch, comments), [patch, comments]);
  const floating = comments.filter((c) => !inline.includes(c));
  const renderComment = (c: ReviewComment) => (
    <CommentCard
      key={c.id}
      comment={c}
      onUpdate={(p) => onUpdateComment(c.id, p)}
      onDelete={() => onDeleteComment(c.id)}
      onDiscuss={onDiscuss && (() => onDiscuss({ target: "comment", id: c.id }))}
      readOnly={readOnly}
      flash={flash === c.id}
    />
  );

  return (
    <section className="chapter" ref={anchorRef}>
      <header className="chapter-head" onClick={onToggle}>
        <span className="faint">{open ? "▾" : "▸"}</span>
        <h3>
          {n} · {chapter.title}
        </h3>
        <span className="faint chapter-meta">
          {chapter.files.length} file{chapter.files.length === 1 ? "" : "s"}
          {comments.length > 0
            ? ` · ${comments.length} comment${comments.length === 1 ? "" : "s"}`
            : " · no comments"}
        </span>
        <span className="grow" />
        {onDiscuss && (
          <button
            className="btn btn-sm"
            onClick={(e) => {
              e.stopPropagation();
              onDiscuss({ target: "chapter", id: chapter.id });
            }}
          >
            <Icon name="comment" />
            discuss
          </button>
        )}
      </header>
      {open && (
        <div className="chapter-body">
          <Markdown className="prose chapter-explanation" text={chapter.explanation} />
          {floating.map(renderComment)}
          <DiffBlock patch={patch} comments={inline} renderComment={renderComment} />
          {!readOnly && chapter.files.length > 0 && (
            <AddComment files={chapter.files} chapterId={chapter.id} onAdd={onAddComment} />
          )}
        </div>
      )}
    </section>
  );
}

/** Plain-English name for the thing a revision touched. */
function describeRevision(revision: Revision, artifact: Artifact): string {
  switch (revision.kind) {
    case "summary":
      return "rewrote the summary";
    case "verdict":
      return `changed the verdict to ${revision.verdict.recommendation.replace("_", " ")}`;
    case "chapter": {
      const ch = artifact.chapters.find((c) => c.id === revision.chapterId);
      return `rewrote the "${ch?.title ?? revision.chapterId}" chapter`;
    }
    case "comment-edit": {
      const c = artifact.comments.find((x) => x.id === revision.commentId);
      return c ? `rewrote the comment on ${c.path}:${c.line ?? "file"}` : "rewrote a comment";
    }
    case "comment-drop": {
      const c = artifact.comments.find((x) => x.id === revision.commentId);
      return c ? `dropped the comment on ${c.path}:${c.line ?? "file"}` : "dropped a comment";
    }
    case "comment-add":
      return `added a comment on ${revision.path}:${revision.line ?? "file"}`;
  }
}

function describeRef(ref: ChatRef, artifact: Artifact): string {
  if (ref.target === "summary") return "the summary";
  if (ref.target === "verdict") return "the verdict";
  if (ref.target === "chapter") {
    return artifact.chapters.find((c) => c.id === ref.id)?.title ?? "a chapter";
  }
  const c = artifact.comments.find((x) => x.id === ref.id);
  return c ? `${c.path}:${c.line ?? "file"}` : "a comment";
}

function ChatTurnView({ turn, artifact }: { turn: ChatTurn; artifact: Artifact }) {
  return (
    <div className={`chat-turn chat-turn-${turn.role}`}>
      <div className="chat-turn-who">{turn.role === "user" ? "You" : "Reviewer"}</div>
      {turn.refs.length > 0 && (
        <div className="chat-refs">
          {turn.refs.map((r, i) => (
            <span key={i} className="chat-ref">
              {describeRef(r, artifact)}
            </span>
          ))}
        </div>
      )}
      <Markdown className="chat-turn-body prose" text={turn.body} />
      {turn.revisions.map((r, i) => (
        <div key={i} className="chat-revision">
          ↳ {describeRevision(r, artifact)}
        </div>
      ))}
      {turn.refused.map((r, i) => (
        <div key={i} className="chat-refusal" title={r.reason}>
          ⃠ left alone — {r.reason}
        </div>
      ))}
    </div>
  );
}

/**
 * The conversation about this review.
 *
 * The reviewer revises the draft as it answers — there is no accept step,
 * because the user asked for the change and a second confirmation on it would
 * be friction wearing safety's coat. Send is still where a human vouches for
 * what reaches GitHub, and the transcript never goes there at all.
 */
function ChatPanel({
  artifact,
  reviewKey,
  refs,
  onClearRefs,
  onDropRef,
  onArtifact,
  readOnly,
  inputRef,
}: {
  artifact: Artifact;
  reviewKey: string;
  refs: ChatRef[];
  onClearRefs: () => void;
  onDropRef: (index: number) => void;
  onArtifact: (a: Artifact) => void;
  readOnly: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [draft, setDraft] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chat = artifact.chat ?? [];
  const pending = artifact.pendingChat ?? null;
  // A turn runs detached, so "busy" outlives the request that started it: it
  // ends when the artifact stops carrying an unanswered question.
  const inFlight = pending != null && pending.error == null;
  const busy = starting || inFlight;

  const start = (message: string, withRefs: ChatRef[], onStarted?: () => void) => {
    if (!message || busy) return;
    setStarting(true);
    setError(null);
    startChatTurn(reviewKey, { message, refs: withRefs })
      .then((a) => {
        onArtifact(a);
        onStarted?.();
      })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setStarting(false));
  };

  const send = () =>
    start(draft.trim(), refs, () => {
      setDraft("");
      onClearRefs();
    });

  return (
    <section className="card chat-panel">
      <header className="card-head">
        <h2>talk to the reviewer</h2>
        <span className="faint">
          it revises the draft as you go · nothing here reaches GitHub — only send does
        </span>
      </header>

      <div className="card-body">
        {(chat.length > 0 || pending) && (
          <div className="chat-log">
            {chat.map((t) => (
              <ChatTurnView key={t.id} turn={t} artifact={artifact} />
            ))}
            {pending && (
              <div className="chat-turn chat-turn-user chat-turn-pending">
                <div className="chat-turn-who">You</div>
                {pending.refs.length > 0 && (
                  <div className="chat-refs">
                    {pending.refs.map((r, i) => (
                      <span key={i} className="chat-ref">
                        {describeRef(r, artifact)}
                      </span>
                    ))}
                  </div>
                )}
                <Markdown className="chat-turn-body prose" text={pending.message} />
                {pending.error ? (
                  <div className="chat-failed">
                    ✕ this turn didn't finish — {pending.error}
                    {!readOnly && (
                      <>
                        {" "}
                        <button className="btn btn-sm" onClick={() => start(pending.message, pending.refs)}>
                          ask again
                        </button>{" "}
                        <button
                          className="btn btn-sm"
                          onClick={() =>
                            dismissPendingChat(reviewKey)
                              .then(onArtifact)
                              .catch((e) => setError(String(e.message ?? e)))
                          }
                        >
                          dismiss
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="chat-waiting">
                    {/* What it is doing right now, in its own words. The last
                        line is the live one; the rest is how it got there. */}
                    {pending.progress.length > 0 ? (
                      <ol className="chat-progress">
                        {pending.progress.map((line, i) => (
                          <li key={i} className={i === pending.progress.length - 1 ? "now" : undefined}>
                            {line}
                          </li>
                        ))}
                      </ol>
                    ) : (
                      "Thinking… it re-reads the code before answering."
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {readOnly ? (
          <p className="faint">
            This review was sent — the conversation is kept as a record, but it can't continue.
          </p>
        ) : (
          <>
            {refs.length > 0 && (
              <div className="chat-refs chat-refs-pending">
                <span className="faint">about:</span>
                {refs.map((r, i) => (
                  <button key={i} className="chat-ref" onClick={() => onDropRef(i)} title="Remove">
                    {describeRef(r, artifact)} ✕
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={inputRef}
              className="chat-input"
              rows={2}
              value={draft}
              // Only the send is blocked while a turn runs — composing the next
              // message during the minutes it takes is exactly what you want to do.
              disabled={starting}
              placeholder={
                chat.length === 0
                  ? "the summary restates the author's claims — say what you actually verified"
                  : "say more…"
              }
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
              }}
            />
            <div className="chat-actions">
              <button className="btn btn-dark" onClick={send} disabled={busy || draft.trim() === ""}>
                <Icon name="send" />
                {inFlight ? "waiting for the answer…" : starting ? "sending…" : "send message"}
                <Key>⌘↵</Key>
              </button>
              <span className="grow" />
              {artifact.preChat && (
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  title="Put the review back the way the AI first wrote it. The conversation stays."
                  onClick={() => {
                    setStarting(true);
                    resetReviewToPreChat(reviewKey)
                      .then(onArtifact)
                      .catch((e) => setError(String(e.message ?? e)))
                      .finally(() => setStarting(false));
                  }}
                >
                  reset the review
                </button>
              )}
            </div>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </section>
  );
}

/**
 * The one place anything reaches GitHub.
 *
 * One primary button, coloured by what it will do. The event follows the
 * verdict, and the switch that decouples them sits quietly underneath — a
 * review that says "request changes" but posts an approve is a thing you should
 * have to mean.
 */
function SendPanel({
  artifact,
  reviewKey,
  event,
  overridden,
  onPickEvent,
  sending,
  onSend,
  error,
  footer,
  next,
  onAdvance,
}: {
  artifact: Artifact;
  reviewKey: string;
  event: ReviewEvent;
  overridden: boolean;
  onPickEvent: (e: ReviewEvent) => void;
  sending: boolean;
  onSend: () => void;
  error: string | null;
  /** The ways out that don't touch GitHub — kept here because this is where
      you are when you decide not to send, but fenced off from the button. */
  footer: ReactNode;
  /** Where the queue goes next, once this one is done with. */
  next: ReviewListItem | null;
  onAdvance: () => void;
}) {
  const [preview, setPreview] = useState<SendPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [showBody, setShowBody] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);

  useEffect(() => {
    if (!showBody) return;
    fetchSendPreview(reviewKey, event)
      .then((p) => {
        setPreview(p);
        setPreviewError(null);
      })
      .catch((e) => setPreviewError(String(e)));
  }, [reviewKey, event, artifact, showBody]);

  if (artifact.sent) {
    return (
      <>
        <div className="sent-strip">
          <strong>✔ sent as {EVENT_LABEL[artifact.sent.event]}</strong>
          <span className="faint">
            {new Date(artifact.sent.at).toLocaleString()} · {payloadSummary(artifact)}
            {artifact.sent.auto ? " · auto-sent by the daemon" : ""}
          </span>
          <span className="grow" />
          {artifact.sent.url && (
            <a href={artifact.sent.url} target="_blank" rel="noreferrer">
              view on GitHub <Icon name="external" />
            </a>
          )}
          {/* Sending is the irreversible step, so it doesn't move you by
              itself — it shows what landed, and offers the way onward. */}
          <button className="btn" onClick={onAdvance}>
            {next ? `next review: ${next.pr.repo}#${next.pr.number}` : "back to the queue"}
            <Icon name="arrowRight" />
          </button>
        </div>
        <div className="post-actions">{footer}</div>
      </>
    );
  }

  return (
    <div className="send-panel">
      <div className="send-top">
        <span className="lab">send to github</span>
        <span className="grow" />
        <span className="faint">{payloadSummary(artifact)}</span>
        <button className="link" onClick={() => setShowBody(!showBody)}>
          <Icon name="eye" />
          {showBody ? "hide what gets posted" : "see what gets posted"}
        </button>
      </div>

      <div className="send-action">
        <button
          className={`send-btn tone-bg-${EVENT_TONE[event]}`}
          disabled={sending}
          onClick={onSend}
        >
          <Icon name={event === "APPROVE" ? "approve" : event === "COMMENT" ? "comment" : "changes"} size={15} />
          {sending ? "sending…" : `${EVENT_LABEL[event]} on ${artifact.id}`} <Key>s</Key>
        </button>

        <div className="send-as">
          <button className="send-as-toggle" onClick={() => setEventsOpen(!eventsOpen)}>
            as <b>{EVENT_LABEL[event]}</b> {eventsOpen ? "▴" : "▾"}
          </button>
          <div className="send-as-why">
            {overridden
              ? `you chose this — the verdict says ${artifact.verdict?.recommendation.replace("_", " ") ?? "nothing"}`
              : "follows the verdict"}
          </div>
          {eventsOpen && (
            <div className="menu">
              {(["REQUEST_CHANGES", "COMMENT", "APPROVE"] as ReviewEvent[]).map((id) => (
                <button
                  key={id}
                  className={`menu-item${event === id ? " menu-item-on" : ""}`}
                  onClick={() => {
                    onPickEvent(id);
                    setEventsOpen(false);
                  }}
                >
                  <span className={`tone-${EVENT_TONE[id]}`}>
                    <Icon name={id === "APPROVE" ? "approve" : id === "COMMENT" ? "comment" : "changes"} />
                  </span>
                  <span className="grow">{EVENT_LABEL[id]}</span>
                  <span className="menu-check">{event === id ? "✓" : ""}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {showBody &&
        (previewError ? (
          <p className="error">{previewError}</p>
        ) : preview ? (
          <pre className="body-preview">{preview.body}</pre>
        ) : (
          <p className="faint">building the body…</p>
        ))}

      <div className="send-footer">{footer}</div>
    </div>
  );
}

function FreshnessBanner({
  artifact,
  freshness,
  rerunning,
  onRerun,
}: {
  artifact: Artifact;
  freshness: RefreshResult | null;
  rerunning: boolean;
  onRerun: () => void;
}) {
  const running = artifact.status === "running";
  const state = freshness?.prState ?? artifact.pr.state;
  const closed = state === "CLOSED" || state === "MERGED";
  const refresh = artifact.refresh;
  const movedHere = freshness?.changed ? refresh : null;

  if (running) {
    return (
      <div className="freshness freshness-running">
        <strong>Re-reviewing…</strong> Claude is reading the current head. This page updates itself
        when the run lands — it takes a few minutes.
      </div>
    );
  }
  if (!closed && !movedHere) return null;

  return (
    <div className="freshness">
      {closed && (
        <div>
          <strong>This PR is {state === "MERGED" ? "merged" : "closed"}.</strong> A review can still
          be sent, but nobody is waiting for it.
        </div>
      )}
      {movedHere && (
        <div>
          <strong>The PR moved on since this review.</strong> Now at{" "}
          <code>{movedHere.toSha.slice(0, 7)}</code>, reviewed at{" "}
          <code>{movedHere.fromSha.slice(0, 7)}</code>.{" "}
          {movedHere.moved > 0 && <>{movedHere.moved} comment(s) followed the code. </>}
          {movedHere.drifted > 0 && (
            <>
              {movedHere.drifted} could not — the code they point at is gone, so they will post in
              the review body instead of inline.{" "}
            </>
          )}
          The summary and verdict still describe the commit that was reviewed.
          {!artifact.sent && (
            <button className="btn btn-sm" disabled={rerunning} onClick={() => onRerun()}>
              {rerunning ? "starting…" : "re-review at the new head"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Detail({ reviewKey }: { reviewKey: string }) {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [freshness, setFreshness] = useState<RefreshResult | null>(null);
  // A freshness check that couldn't reach GitHub is news about GitHub, not
  // about this review — the draft on disk is still every bit as readable.
  const [freshnessError, setFreshnessError] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [neighbours, setNeighbours] = useState<ReviewListItem[]>([]);
  // What the user has pointed at with "discuss this", waiting to be sent with
  // their next message. Lives here so a button anywhere in the walkthrough can
  // reach the one chat panel at the bottom.
  const [chatRefs, setChatRefs] = useState<ChatRef[]>([]);
  const chatInput = useRef<HTMLTextAreaElement | null>(null);
  // Chapters are open by default — the walkthrough is the point of the page.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState(0);
  const chapterEls = useRef<Map<string, HTMLElement>>(new Map());
  const verdictEl = useRef<HTMLDivElement | null>(null);
  const topEl = useRef<HTMLDivElement | null>(null);
  const [eventOverride, setEventOverride] = useState<ReviewEvent | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // The comment the rail just sent you to, marked until you've had time to see it.
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(timer);
  }, [flash]);

  const discuss = (ref: ChatRef) => {
    setChatRefs((refs) =>
      refs.some((r) => r.target === ref.target && r.id === ref.id) ? refs : [...refs, ref],
    );
    // Pointing at something is only useful if you can then type about it.
    chatInput.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    chatInput.current?.focus();
  };

  useEffect(() => {
    let cancelled = false;
    // Walking to another review starts at its top, not wherever the last one
    // left the page.
    window.scrollTo({ top: 0 });
    setFreshness(null);
    setFreshnessError(null);
    setEventOverride(null);
    setSendError(null);
    fetchReview(reviewKey)
      .then((a) => {
        if (cancelled) return;
        setArtifact(a);
        // Opening a review checks GitHub for new commits and pulls the comments
        // forward onto them, so what you read is anchored to current code. If
        // that check fails the review still reads — it is just older than we
        // can prove, which is what the note says.
        return refreshReview(reviewKey)
          .then((r) => {
            if (cancelled) return;
            setFreshness(r);
            if (r.changed) setArtifact(r.artifact);
          })
          .catch((e) => !cancelled && setFreshnessError(String(e.message ?? e)));
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [reviewKey]);

  // The ‹ › arrows walk the same queue the list screen shows, so leaving a
  // review lands on the next one that wants you rather than back at the table.
  useEffect(() => {
    fetchReviews()
      .then(setNeighbours)
      .catch(() => {});
  }, []);

  // The header is sticky and its height depends on how the title wraps, so
  // everything that scrolls under it — the rail, a jumped-to chapter or
  // comment — clears it by measurement rather than by a guessed constant.
  useEffect(() => {
    const el = topEl.current;
    if (!el) return;
    const apply = () =>
      document.documentElement.style.setProperty("--top-h", `${el.offsetHeight}px`);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--top-h");
    };
  }, [artifact?.id]);

  // While AI work is in flight — a re-review, or a chat turn — follow it until
  // it lands. Both run detached, so the artifact is the only thing that knows.
  const chatInFlight = artifact?.pendingChat != null && artifact.pendingChat.error == null;
  useEffect(() => {
    if (artifact?.status !== "running" && !chatInFlight) return;
    const timer = setInterval(() => {
      fetchReview(reviewKey)
        .then((a) => {
          setArtifact(a);
          if (a.status !== "running") setRerunning(false);
        })
        .catch(() => {
          // Transient — the next tick tries again.
        });
    }, 3000);
    return () => clearInterval(timer);
  }, [artifact?.status, chatInFlight, reviewKey]);

  const readOnly = artifact?.sent != null;
  // The walk is the queue as it stood when this page opened. Deliberately not
  // refetched: finishing this review must not renumber the walk under you or
  // strand the arrows on a list this PR has just left.
  const walk = useMemo(() => walkable(neighbours), [neighbours]);
  const at = walk.findIndex((r) => r.key === reviewKey);
  const prev = (at > 0 ? walk[at - 1] : null) ?? null;
  const next = (at >= 0 && at < walk.length - 1 ? walk[at + 1] : null) ?? null;

  const goTo = (key: string) => {
    window.location.hash = `#/r/${encodeURIComponent(key)}`;
  };

  /** Done here — on to the next review that wants you, or back to the queue. */
  const advance = () => {
    if (next) goTo(next.key);
    else window.location.hash = "#/";
  };

  const chapters: Chapter[] = useMemo(() => {
    if (!artifact) return [];
    const other = unclaimedFiles(artifact.diff, artifact.chapters);
    return other.length > 0
      ? [
          ...artifact.chapters,
          {
            id: "__other",
            title: "other changes",
            explanation: "Files not assigned to any chapter by the AI.",
            files: other,
          },
        ]
      : artifact.chapters;
  }, [artifact]);

  const openChapter = (i: number) => {
    const ch = chapters[i];
    if (!ch) return null;
    setFocused(i);
    setCollapsed((s) => {
      const next = new Set(s);
      next.delete(ch.id);
      return next;
    });
    return ch;
  };

  const goChapter = (i: number) => {
    const ch = openChapter(i);
    if (ch) chapterEls.current.get(ch.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const goComment = (chapterIndex: number, commentId: string) => {
    openChapter(chapterIndex);
    setFlash(commentId);
    scrollToComment(commentId);
  };

  const event = eventOverride ?? eventForVerdict(artifact?.verdict);
  // A verdict change re-points the event at it: the switch below the button is
  // an override of the verdict, not a setting that outlives it.
  const recommendation = artifact?.verdict?.recommendation;
  useEffect(() => setEventOverride(null), [recommendation]);
  // A failure belongs to the send it came from; changing what you'd send makes
  // it history rather than a warning about the button in front of you.
  useEffect(() => setSendError(null), [event]);

  const doSend = () => {
    if (!artifact || artifact.sent || sending) return;
    setSending(true);
    setSendError(null);
    sendReview(reviewKey, event)
      .then(setArtifact)
      .catch((e) => setSendError(String(e.message ?? e)))
      .finally(() => setSending(false));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "[" && prev) goTo(prev.key);
      else if (e.key === "]" && next) goTo(next.key);
      else if (e.key === "n") goChapter(Math.min(chapters.length - 1, focused + 1));
      else if (e.key === "N") goChapter(Math.max(0, focused - 1));
      else if (e.key === "s" && !readOnly) doSend();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prev?.key, next?.key, chapters, focused, readOnly, event, artifact?.sent, sending]);

  // Only a review that failed to load has nothing to show; anything else is a
  // note on a page that still works.
  if (error && !artifact) return <p className="error pad">{error}</p>;
  if (!artifact) return <p className="muted pad">Loading…</p>;

  const onRerun = (withSource?: boolean) => {
    setRerunning(true);
    setError(null);
    rerunReview(reviewKey, withSource)
      .then(setArtifact)
      .catch((e) => {
        setError(String(e));
        setRerunning(false);
      });
  };

  const apply = (p: Promise<Artifact>) => p.then(setArtifact).catch((e) => setError(String(e)));

  /** Settle this review locally and move on. Stays put if the write failed. */
  const settle = (status: "reviewed" | "skipped") =>
    patchReview(reviewKey, { status })
      .then(advance)
      .catch((e) => setError(String(e)));
  const onUpdateComment = (id: string, patch: { body?: string; status?: string }) =>
    apply(patchComment(reviewKey, id, patch));
  const onDeleteComment = (id: string) => apply(deleteComment(reviewKey, id));
  const onAddComment = (c: { path: string; line: number | null; body: string; chapterId: string | null }) =>
    apply(addComment(reviewKey, c));

  const orphanComments = artifact.comments.filter(
    (c) => !c.chapterId || !chapters.some((ch) => ch.id === c.chapterId),
  );
  const { inline, folded, dropped } = splitComments(artifact);
  const drifted = artifact.comments.filter((c) => c.status !== "dropped" && c.drifted).length;
  const tone = artifact.verdict ? TONE[artifact.verdict.recommendation] : "none";
  // The findings changed under the verdict (a blocker dropped, a grade edited).
  // Never auto-rewritten: the hint hands it to the chat, one click, on request.
  const mismatch = verdictMismatch(artifact);
  const chatBusy = artifact.pendingChat != null && artifact.pendingChat.error == null;
  const retrue = () =>
    apply(
      startChatTurn(reviewKey, {
        message:
          "Some findings were dropped, edited or re-graded after this review was drafted. Update the summary and verdict to match what still stands — do not re-review the whole PR.",
        refs: [{ target: "verdict", id: null }],
      }),
    );
  const readLabel = artifact.run?.trusted
    ? "ran the code"
    : artifact.run?.withSource
      ? "read the full source"
      : artifact.run
        ? "read the diff only"
        : "no run yet";

  const verdictButton = (rec: Verdict["recommendation"]) => (
    <button
      key={rec}
      className={`verdict-pick${artifact.verdict?.recommendation === rec ? ` verdict-pick-on tone-${TONE[rec]}` : ""}`}
      title={
        rec === "approve"
          ? "Approve"
          : rec === "comment"
            ? "Comment without blocking"
            : "Request changes"
      }
      onClick={() => apply(patchReview(reviewKey, { verdictRecommendation: rec }))}
    >
      <Icon name={VERDICT_ICON[rec]} />
      {rec.replace("_", " ")}
    </button>
  );

  return (
    <div className="review">
      {/* Which PR, which verdict and the way out of it stay put — a long
          walkthrough should never leave you wondering what you are reading. */}
      <div className="review-top" ref={topEl}>
        <div className="crumb">
          <div className="bar-inner">
            <a href="#/">← queue</a>
            <span className="crumb-sep">/</span>
            <span className="crumb-slug">{artifact.id}</span>
            <span className="walk">
              <button
                className="walk-btn"
                disabled={!prev}
                title={prev ? `[ — ${prev.id}: ${prev.pr.title}` : "no more reviews this way"}
                onClick={() => prev && goTo(prev.key)}
              >
                <Icon name="chevronLeft" />
              </button>
              <button
                className="walk-btn"
                disabled={!next}
                title={next ? `] — ${next.id}: ${next.pr.title}` : "no more reviews this way"}
                onClick={() => next && goTo(next.key)}
              >
                <Icon name="chevronRight" />
              </button>
            </span>
            {at >= 0 && (
              <span className="faint">
                {at + 1} of {walk.length} awaiting
              </span>
            )}
            <span className="faint crumb-next">
              {next ? `next: ${next.pr.title}` : at >= 0 ? "last in the queue" : ""}
            </span>
            <span className="grow" />
            <a href="#/settings" className="topbar-link" title="settings" aria-label="settings">
              <Icon name="settings" size={15} />
            </a>
          </div>
        </div>

        <div className="review-head">
          <div className="wrap">
            <div className="review-head-top">
              <a className="review-title" href={artifact.pr.url} target="_blank" rel="noreferrer">
                {artifact.pr.title}
              </a>
              {artifact.verdict &&
                (readOnly ? (
                  <span className={`chip tone-${tone}`}>
                    {artifact.verdict.recommendation.replace("_", " ")} · {artifact.verdict.confidence}%
                  </span>
                ) : (
                  // The verdict is decided next to send, at the foot of the page.
                  // Up here it is a fact you can jump to, not a control.
                  <button
                    className={`chip chip-btn tone-${tone}`}
                    title="change it, or send — both are at the foot of the page"
                    onClick={() => verdictEl.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
                  >
                    {artifact.verdict.recommendation.replace("_", " ")} · {artifact.verdict.confidence}%
                    <Icon name="down" size={12} />
                  </button>
                ))}
              <span className="grow" />
            </div>
            <div className="review-head-meta">
              <span>{artifact.pr.author}</span>
              <span className="crumb-sep">·</span>
              <span>
                {artifact.pr.headRefName} → {artifact.pr.baseRefName}
                {artifact.pr.headSha ? ` · ${artifact.pr.headSha.slice(0, 7)}` : ""}
              </span>
              <span className="crumb-sep">·</span>
              <span>
                {artifact.pr.changedFiles}f <span className="add">+{artifact.pr.additions}</span>{" "}
                <span className="del">−{artifact.pr.deletions}</span>
              </span>
              <span className="crumb-sep">·</span>
              <span title="Whether the run read a local checkout of the PR head, or the diff alone.">
                {readLabel}
              </span>
              {artifact.run?.costUsd != null && (
                <>
                  <span className="crumb-sep">·</span>
                  <span title="What this review would cost at API token rates. Riding a Claude subscription, it draws on your usage limits instead.">
                    ≈${artifact.run.costUsd.toFixed(2)} at API rates
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="wrap review-body">
        <aside className="rail">
          {chapters.length > 0 && (
            <>
              <div className="lab">walkthrough</div>
              {chapters.map((ch, i) => (
                <div key={ch.id} className="rail-group">
                  <button
                    className={`rail-item${!collapsed.has(ch.id) ? " rail-item-on" : ""}`}
                    onClick={() => goChapter(i)}
                  >
                    <span className="grow">
                      {i + 1} · {ch.title}
                    </span>
                    <span className="rail-count">{ch.files.length}f</span>
                  </button>
                  {/* Where the comments are, before you go looking for them. */}
                  {artifact.comments
                    .filter((c) => c.chapterId === ch.id)
                    .map((c) => (
                      <button
                        key={c.id}
                        className={`rail-comment${c.status === "dropped" ? " rail-comment-dropped" : ""}`}
                        title={`${c.path}${c.line != null ? `:${c.line}` : ""} — ${c.body}`}
                        onClick={() => goComment(i, c.id)}
                      >
                        <span className={`rail-dot tone-${commentTone(c, tone)}`}>●</span>
                        <span className="rail-comment-loc">
                          {c.path.split("/").pop()}
                          {c.line != null ? `:${c.drifted ? "~" : ""}${c.line}` : ""}
                        </span>
                      </button>
                    ))}
                </div>
              ))}
            </>
          )}

          <div className={`lab${chapters.length > 0 ? " rail-lab" : ""}`}>comments</div>
          <div className="rail-facts">
            <div>
              {artifact.comments.length - dropped.length} keeping · {dropped.length} dropped
            </div>
            <div>
              {inline.length} inline · {folded.length} folded into body
            </div>
            {drifted > 0 && (
              <div className="warn" title="The code these comments pointed at is gone from the diff.">
                {drifted} drifted
              </div>
            )}
          </div>

          <div className="lab rail-lab">run</div>
          <div className="rail-facts">
            <div>
              status <b>{artifact.status}</b>
            </div>
            {!readOnly && artifact.status !== "running" && (
              <button className="link" disabled={rerunning} onClick={() => onRerun(true)}>
                {rerunning ? "starting…" : artifact.run ? "re-review at head" : "review now"}
              </button>
            )}
          </div>
        </aside>

        <div className="main">
          <FreshnessBanner
            artifact={artifact}
            freshness={freshness}
            rerunning={rerunning}
            onRerun={onRerun}
          />
          {freshnessError && (
            <div className="freshness" title={freshnessError}>
              <strong>Couldn't check GitHub for newer commits.</strong> This is the review as it was
              drafted — if the PR has moved on since, nothing here knows it yet.
            </div>
          )}
          {error && <div className="error">{error}</div>}
          {artifact.run?.error && <div className="error">Run failed: {artifact.run.error}</div>}

          {artifact.verdict && (
            <div className={`card card-why tone-border-${tone}`}>
              <div className="card-body">
                <div className="lab">why</div>
                {severitySummary(artifact) && (
                  <div className="sev-counts" title="Live findings by grade. Only blockers block.">
                    {severitySummary(artifact)}
                  </div>
                )}
                <Markdown className="prose lead" text={artifact.verdict.reasoning} />
                {!readOnly && (
                  <button className="btn btn-sm" onClick={() => discuss({ target: "verdict", id: null })}>
                    <Icon name="comment" />
                    discuss the verdict
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-body">
              <div className="lab">summary</div>
              <Markdown className="prose lead" text={artifact.summary || "(no summary)"} />
              {!readOnly && (
                <button className="btn btn-sm" onClick={() => discuss({ target: "summary", id: null })}>
                  <Icon name="comment" />
                  discuss the summary
                </button>
              )}
            </div>
          </div>

          {chapters.map((ch, i) => (
            <ChapterSection
              key={ch.id}
              chapter={ch}
              n={i + 1}
              diff={artifact.diff}
              comments={artifact.comments.filter((c) => c.chapterId === ch.id)}
              open={!collapsed.has(ch.id)}
              onToggle={() =>
                setCollapsed((s) => {
                  const nextSet = new Set(s);
                  if (nextSet.has(ch.id)) nextSet.delete(ch.id);
                  else nextSet.add(ch.id);
                  return nextSet;
                })
              }
              onUpdateComment={onUpdateComment}
              onDeleteComment={onDeleteComment}
              onAddComment={onAddComment}
              onDiscuss={readOnly ? undefined : discuss}
              readOnly={readOnly}
              flash={flash}
              anchorRef={(el) => {
                if (el) chapterEls.current.set(ch.id, el);
                else chapterEls.current.delete(ch.id);
              }}
            />
          ))}

          {orphanComments.length > 0 && (
            <section className="card">
              <header className="card-head">
                <h2>unattached comments</h2>
                <span className="faint">not part of any chapter — they post in the body</span>
              </header>
              <div className="card-body">
                {orphanComments.map((c) => (
                  <CommentCard
                    key={c.id}
                    comment={c}
                    onUpdate={(p) => onUpdateComment(c.id, p)}
                    onDelete={() => onDeleteComment(c.id)}
                    onDiscuss={readOnly ? undefined : () => discuss({ target: "comment", id: c.id })}
                    readOnly={readOnly}
                  />
                ))}
              </div>
            </section>
          )}

          <ChatPanel
            artifact={artifact}
            reviewKey={reviewKey}
            refs={chatRefs}
            onClearRefs={() => setChatRefs([])}
            onDropRef={(i) => setChatRefs((refs) => refs.filter((_, n) => n !== i))}
            onArtifact={setArtifact}
            readOnly={readOnly}
            inputRef={chatInput}
          />

          {/* The verdict was written against findings that may since have been
              dropped, edited or re-graded. Nothing auto-rewrites it — the hint
              says they disagree, and one click hands it to the chat, which
              already knows how to revise a draft. */}
          {!readOnly && mismatch && (
            <div className="verdict-hint">
              <span>
                <strong>{mismatch}</strong> — the verdict was written before those edits.
              </span>
              <button className="btn btn-sm" onClick={retrue} disabled={chatBusy}>
                <Icon name="comment" />
                {chatBusy ? "the reviewer is busy…" : "ask the reviewer to re-true it"}
              </button>
            </div>
          )}
          {artifact.verdict && !readOnly && (
            <div className="verdict-bar" ref={verdictEl}>
              <span className="lab">verdict</span>
              {(["approve", "comment", "request_changes"] as const).map(verdictButton)}
              <span className="grow" />
              <span className="faint">what you send follows this unless you say otherwise</span>
            </div>
          )}

          <SendPanel
            artifact={artifact}
            reviewKey={reviewKey}
            event={event}
            overridden={eventOverride != null}
            onPickEvent={setEventOverride}
            sending={sending}
            onSend={doSend}
            error={sendError}
            next={next}
            onAdvance={advance}
            footer={
              <>
                <span className="faint">not sending?</span>
                {!readOnly && (
                  <>
                    {/* Both mean "I'm done with this one" — so they move you on. */}
                    <button
                      className="btn btn-sm"
                      title={
                        next
                          ? `Settle it locally and go to ${next.id}`
                          : "Settle it locally and go back to the queue"
                      }
                      onClick={() => settle("reviewed")}
                    >
                      <Icon name="check" />
                      mark reviewed
                    </button>
                    <button
                      className="btn btn-sm"
                      title={next ? `Leave it and go to ${next.id}` : "Leave it and go back to the queue"}
                      onClick={() => settle("skipped")}
                    >
                      <Icon name="skip" />
                      skip
                    </button>
                  </>
                )}
                <a className="btn btn-sm" href={exportUrl(reviewKey)}>
                  <Icon name="download" />
                  export .md
                </a>
              </>
            }
          />
        </div>
      </div>
    </div>
  );
}
