import { html } from "diff2html";
import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { newSideLines, patchForFiles, unclaimedFiles } from "../../src/core/diff";
import {
  addComment,
  deleteComment,
  exportUrl,
  fetchReview,
  fetchSendPreview,
  patchComment,
  patchReview,
  refreshReview,
  rerunReview,
  resetReviewToPreChat,
  sendChatTurn,
  sendReview,
} from "./api";
import { highlightDiff } from "./highlight";
import { Markdown } from "./Markdown";
import {
  Artifact,
  Chapter,
  ChatRef,
  ChatTurn,
  RefreshResult,
  Revision,
  ReviewComment,
  SendPreview,
} from "./types";

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
}: {
  comment: ReviewComment;
  onUpdate: (patch: { body?: string; status?: string }) => void;
  onDelete: () => void;
  onDiscuss?: () => void;
  readOnly: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);

  return (
    <div className={`comment comment-${comment.status}`}>
      <div className="comment-loc">
        {comment.path}
        {comment.line != null ? `:${comment.line}` : ""}{" "}
        <span className="muted">({comment.origin})</span>
        {comment.status === "dropped" && <span className="badge badge-muted"> dropped</span>}
        {comment.status === "approved" && <span className="badge badge-green"> approved</span>}
        {comment.drifted && (
          <span className="badge badge-warn" title="The code this comment points at changed in a newer commit. It will post in the review body instead of inline.">
            {" "}
            code changed — posts in body
          </span>
        )}
        {!comment.drifted && comment.originalLine != null && comment.originalLine !== comment.line && (
          <span className="muted" title="This comment followed its code to a new line."> (was :{comment.originalLine})</span>
        )}
        {!readOnly && (
          <span className="comment-actions">
            {editing ? (
              <>
                <button
                  onClick={() => {
                    onUpdate({ body: draft });
                    setEditing(false);
                  }}
                >
                  save
                </button>
                <button
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
                {onDiscuss && (
                  <button onClick={onDiscuss} title="Ask the reviewer about this comment">
                    discuss
                  </button>
                )}
                <button onClick={() => setEditing(true)}>edit</button>
                {comment.status !== "approved" && (
                  <button onClick={() => onUpdate({ status: "approved" })}>approve</button>
                )}
                {comment.status !== "dropped" ? (
                  <button onClick={() => onUpdate({ status: "dropped" })}>drop</button>
                ) : (
                  <button onClick={() => onUpdate({ status: "draft" })}>restore</button>
                )}
                <button onClick={onDelete}>delete</button>
              </>
            )}
          </span>
        )}
      </div>
      {editing ? (
        <textarea
          className="comment-edit"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.max(3, draft.split("\n").length)}
        />
      ) : (
        <Markdown className="comment-body" text={comment.body} />
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
      <button className="add-comment-btn" onClick={() => setOpen(true)}>
        + add comment
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
      <textarea
        placeholder="Your comment…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
      />
      <div className="add-comment-row">
        <button
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
        <button onClick={() => setOpen(false)}>cancel</button>
      </div>
    </div>
  );
}

function ChapterSection({
  chapter,
  diff,
  comments,
  onUpdateComment,
  onDeleteComment,
  onAddComment,
  onDiscuss,
  readOnly,
}: {
  chapter: Chapter;
  diff: string;
  comments: ReviewComment[];
  onUpdateComment: (id: string, patch: { body?: string; status?: string }) => void;
  onDeleteComment: (id: string) => void;
  onAddComment: (c: { path: string; line: number | null; body: string; chapterId: string | null }) => void;
  onDiscuss?: (ref: ChatRef) => void;
  readOnly: boolean;
}) {
  const [open, setOpen] = useState(true);
  const patch = useMemo(() => patchForFiles(diff, chapter.files), [diff, chapter.files]);
  // Comments that point at a line present in the diff render inline under that
  // line (like GitHub); the rest render as cards above the diff.
  const anchorable = useMemo(() => newSideLines(patch), [patch]);
  const inline = comments.filter((c) => c.line != null && anchorable.get(c.path)?.has(c.line));
  const floating = comments.filter((c) => !inline.includes(c));
  const renderComment = (c: ReviewComment) => (
    <CommentCard
      key={c.id}
      comment={c}
      onUpdate={(p) => onUpdateComment(c.id, p)}
      onDelete={() => onDeleteComment(c.id)}
      onDiscuss={onDiscuss && (() => onDiscuss({ target: "comment", id: c.id }))}
      readOnly={readOnly}
    />
  );
  return (
    <section className="chapter">
      <h3 onClick={() => setOpen(!open)} className={`chapter-title${open ? " chapter-title-open" : ""}`}>
        {open ? "▾" : "▸"} {chapter.title}{" "}
        <span className="muted">
          ({chapter.files.length} file{chapter.files.length === 1 ? "" : "s"}
          {comments.length > 0 ? `, ${comments.length} comment${comments.length === 1 ? "" : "s"}` : ""})
        </span>
      </h3>
      {open && (
        <>
          <Markdown className="chapter-explanation" text={chapter.explanation} />
          {onDiscuss && (
            <button
              className="discuss-btn"
              onClick={() => onDiscuss({ target: "chapter", id: chapter.id })}
            >
              discuss this chapter
            </button>
          )}
          {floating.map(renderComment)}
          {!readOnly && chapter.files.length > 0 && (
            <AddComment files={chapter.files} chapterId={chapter.id} onAdd={onAddComment} />
          )}
          <DiffBlock patch={patch} comments={inline} renderComment={renderComment} />
        </>
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
      <Markdown className="chat-turn-body" text={turn.body} />
      {turn.revisions.map((r, i) => (
        <div key={i} className="chat-revision">
          ✎ {describeRevision(r, artifact)}
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chat = artifact.chat ?? [];

  const send = () => {
    const message = draft.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    sendChatTurn(reviewKey, { message, refs })
      .then((result) => {
        onArtifact(result.artifact);
        setDraft("");
        onClearRefs();
      })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="chat-panel">
      <div className="chat-head">
        <h2>Talk to the reviewer</h2>
        <span className="muted">
          It revises the draft as you go. Nothing here reaches GitHub — only Send does.
        </span>
      </div>

      {chat.length > 0 && (
        <div className="chat-log">
          {chat.map((t) => (
            <ChatTurnView key={t.id} turn={t} artifact={artifact} />
          ))}
        </div>
      )}

      {readOnly ? (
        <p className="muted">
          This review was sent — the conversation is kept as a record, but it can't continue.
        </p>
      ) : (
        <>
          {refs.length > 0 && (
            <div className="chat-refs chat-refs-pending">
              <span className="muted">About:</span>
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
            rows={3}
            value={draft}
            disabled={busy}
            placeholder={
              chat.length === 0
                ? "e.g. the summary is restating the author's claims — say what you actually verified"
                : "Say more…"
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
            }}
          />
          <div className="chat-actions">
            <button className="chat-send" onClick={send} disabled={busy || draft.trim() === ""}>
              {busy ? "Thinking… (it re-reads the code)" : "Send message"}
            </button>
            <span className="muted">⌘↵</span>
            {artifact.preChat && (
              <button
                className="chat-reset"
                disabled={busy}
                title="Put the review back the way the AI first wrote it. The conversation stays."
                onClick={() => {
                  setBusy(true);
                  resetReviewToPreChat(reviewKey)
                    .then(onArtifact)
                    .catch((e) => setError(String(e.message ?? e)))
                    .finally(() => setBusy(false));
                }}
              >
                Reset the review
              </button>
            )}
          </div>
          {error && <div className="error">{error}</div>}
        </>
      )}
    </section>
  );
}

function SendPanel({
  artifact,
  reviewKey,
  onSent,
}: {
  artifact: Artifact;
  reviewKey: string;
  onSent: (a: Artifact) => void;
}) {
  const defaultEvent =
    artifact.verdict?.recommendation === "approve"
      ? "APPROVE"
      : artifact.verdict?.recommendation === "request_changes"
        ? "REQUEST_CHANGES"
        : "COMMENT";
  const [event, setEvent] = useState<string>(defaultEvent);
  const [preview, setPreview] = useState<SendPreview | null>(null);
  const [showBody, setShowBody] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSendPreview(reviewKey, event).then(setPreview).catch((e) => setError(String(e)));
  }, [reviewKey, event, artifact]);

  if (artifact.sent) {
    return (
      <div className="send-panel sent">
        ✔ Review sent ({artifact.sent.event}
        {artifact.sent.auto ? ", auto-sent by daemon" : ""}) at{" "}
        {new Date(artifact.sent.at).toLocaleString()}
        {artifact.sent.url && (
          <>
            {" — "}
            <a href={artifact.sent.url} target="_blank" rel="noreferrer">
              view on GitHub
            </a>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="send-panel">
      <div className="send-head">
        <h2>Send to GitHub</h2>
        <span className="muted">
          the send button posts straight away · dropped comments stay local · off-diff comments
          fold into the body
        </span>
      </div>
      <div className="send-controls">
        <label className="send-as">
          Send as
          <select value={event} onChange={(e) => setEvent(e.target.value)}>
            <option value="COMMENT">Comment</option>
            <option value="APPROVE">Approve</option>
            <option value="REQUEST_CHANGES">Request changes</option>
          </select>
        </label>
        {preview && (
          <span className="muted">
            {preview.comments.length} inline comment{preview.comments.length === 1 ? "" : "s"}
            {preview.folded.length > 0 && <> + {preview.folded.length} folded into body</>}
          </span>
        )}
        <span className="send-spacer" />
        <button onClick={() => setShowBody(!showBody)}>
          {showBody ? "hide" : "preview"} body
        </button>
        <a href={exportUrl(reviewKey)} className="export-link">
          export .md
        </a>
        <button
          className="send-btn"
          disabled={sending}
          onClick={async () => {
            setSending(true);
            setError(null);
            try {
              const updated = await sendReview(reviewKey, event);
              onSent(updated);
            } catch (e) {
              setError(String(e));
            } finally {
              setSending(false);
            }
          }}
        >
          {sending ? "Sending…" : `Send ${event} to #${artifact.pr.number}`}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {showBody && preview && <pre className="body-preview">{preview.body}</pre>}
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
            <button className="rerun-btn" disabled={rerunning} onClick={() => onRerun()}>
              {rerunning ? "starting…" : "Re-review at the new head"}
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
  const [rerunning, setRerunning] = useState(false);
  // What the user has pointed at with "discuss this", waiting to be sent with
  // their next message. Lives here so a button anywhere in the walkthrough can
  // reach the one chat panel at the bottom.
  const [chatRefs, setChatRefs] = useState<ChatRef[]>([]);
  const chatInput = useRef<HTMLTextAreaElement | null>(null);

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
    setFreshness(null);
    fetchReview(reviewKey)
      .then((a) => {
        if (cancelled) return;
        setArtifact(a);
        // Opening a review checks GitHub for new commits and pulls the comments
        // forward onto them, so what you read is anchored to current code.
        return refreshReview(reviewKey).then((r) => {
          if (cancelled) return;
          setFreshness(r);
          if (r.changed) setArtifact(r.artifact);
        });
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [reviewKey]);

  // While an AI run is in flight, follow it until it lands.
  useEffect(() => {
    if (artifact?.status !== "running") return;
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
  }, [artifact?.status, reviewKey]);

  if (error) return <p className="error">{error}</p>;
  if (!artifact) return <p className="muted">Loading…</p>;

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

  const readOnly = artifact.sent != null;
  const apply = (p: Promise<Artifact>) => p.then(setArtifact).catch((e) => setError(String(e)));
  const onUpdateComment = (id: string, patch: { body?: string; status?: string }) =>
    apply(patchComment(reviewKey, id, patch));
  const onDeleteComment = (id: string) => apply(deleteComment(reviewKey, id));
  const onAddComment = (c: { path: string; line: number | null; body: string; chapterId: string | null }) =>
    apply(addComment(reviewKey, c));

  const otherFiles = unclaimedFiles(artifact.diff, artifact.chapters);
  const orphanComments = artifact.comments.filter(
    (c) => !c.chapterId || !artifact.chapters.some((ch) => ch.id === c.chapterId),
  );

  return (
    <div className="detail">
      <a href="#/" className="back">
        ← queue
      </a>
      <h1>
        <a href={artifact.pr.url} target="_blank" rel="noreferrer">
          {artifact.id}
        </a>{" "}
        {artifact.pr.title}
      </h1>
      <p className="muted">
        {artifact.pr.author} · {artifact.pr.headRefName} → {artifact.pr.baseRefName} ·{" "}
        {artifact.pr.changedFiles}f <span className="add">+{artifact.pr.additions}</span>{" "}
        <span className="del">-{artifact.pr.deletions}</span>
        {artifact.run?.costUsd != null && (
          <span title="What this review would cost at API token rates. Riding a Claude subscription, it draws on your usage limits instead.">
            {" "}
            · ≈${artifact.run.costUsd.toFixed(2)} at API rates
          </span>
        )}{" "}
        ·{" "}
        {artifact.run?.trusted
          ? "ran the code"
          : artifact.run?.withSource
            ? "read the full source"
            : "read the diff only"}{" "}
        · status:{" "}
        <strong>{artifact.status}</strong>
        {!readOnly && artifact.status !== "running" && !artifact.run?.withSource && (
          <button
            className="rerun-btn"
            disabled={rerunning}
            title="Re-review with a local checkout of the PR head, so the AI can read the code around the diff instead of hedging over context it cannot see."
            onClick={() => onRerun(true)}
          >
            {rerunning ? "starting…" : "Re-review with full source"}
          </button>
        )}
      </p>

      {artifact.verdict && (
        <div className={`verdict verdict-${artifact.verdict.recommendation}`}>
          <strong>{artifact.verdict.recommendation.replace("_", " ")}</strong> · confidence{" "}
          {artifact.verdict.confidence}%
          {!readOnly && (
            <select
              className="verdict-override"
              value={artifact.verdict.recommendation}
              onChange={(e) => apply(patchReview(reviewKey, { verdictRecommendation: e.target.value }))}
            >
              <option value="approve">approve</option>
              <option value="comment">comment</option>
              <option value="request_changes">request changes</option>
            </select>
          )}
          <Markdown text={artifact.verdict.reasoning} />
        </div>
      )}

      <FreshnessBanner
        artifact={artifact}
        freshness={freshness}
        rerunning={rerunning}
        onRerun={onRerun}
      />

      {artifact.run?.error && <div className="error">Run failed: {artifact.run.error}</div>}

      <section className="summary">
        <h2>Summary</h2>
        <Markdown className="summary-body" text={artifact.summary || "(no summary)"} />
        {!readOnly && (
          <button className="discuss-btn" onClick={() => discuss({ target: "summary", id: null })}>
            discuss the summary
          </button>
        )}
      </section>

      <h2>Walkthrough</h2>
      {artifact.chapters.map((ch) => (
        <ChapterSection
          key={ch.id}
          chapter={ch}
          diff={artifact.diff}
          comments={artifact.comments.filter((c) => c.chapterId === ch.id)}
          onUpdateComment={onUpdateComment}
          onDeleteComment={onDeleteComment}
          onAddComment={onAddComment}
          onDiscuss={readOnly ? undefined : discuss}
          readOnly={readOnly}
        />
      ))}

      {otherFiles.length > 0 && (
        <ChapterSection
          chapter={{
            id: "__other",
            title: "Other changes",
            explanation: "Files not assigned to any chapter by the AI.",
            files: otherFiles,
          }}
          diff={artifact.diff}
          comments={[]}
          onUpdateComment={onUpdateComment}
          onDeleteComment={onDeleteComment}
          onAddComment={onAddComment}
          onDiscuss={readOnly ? undefined : discuss}
          readOnly={readOnly}
        />
      )}

      {orphanComments.length > 0 && (
        <section className="chapter">
          <h3>Unattached comments</h3>
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

      <SendPanel artifact={artifact} reviewKey={reviewKey} onSent={setArtifact} />

      {!readOnly && (
        <p className="muted post-actions">
          Or set the local queue status without sending anything:{" "}
          <button onClick={() => apply(patchReview(reviewKey, { status: "reviewed" }))}>
            mark reviewed
          </button>{" "}
          <button onClick={() => apply(patchReview(reviewKey, { status: "skipped" }))}>skip</button>
        </p>
      )}
    </div>
  );
}
