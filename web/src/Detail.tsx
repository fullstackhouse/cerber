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
  sendReview,
} from "./api";
import { highlightDiff } from "./highlight";
import { Markdown } from "./Markdown";
import { Artifact, Chapter, RefreshResult, ReviewComment, SendPreview } from "./types";

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
  readOnly,
}: {
  comment: ReviewComment;
  onUpdate: (patch: { body?: string; status?: string }) => void;
  onDelete: () => void;
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
  readOnly,
}: {
  chapter: Chapter;
  diff: string;
  comments: ReviewComment[];
  onUpdateComment: (id: string, patch: { body?: string; status?: string }) => void;
  onDeleteComment: (id: string) => void;
  onAddComment: (c: { path: string; line: number | null; body: string; chapterId: string | null }) => void;
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
        {artifact.run?.costUsd != null && <> · review cost ${artifact.run.costUsd.toFixed(2)}</>} ·{" "}
        {artifact.run?.withSource ? "read the full source" : "read the diff only"} · status:{" "}
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
              readOnly={readOnly}
            />
          ))}
        </section>
      )}

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
