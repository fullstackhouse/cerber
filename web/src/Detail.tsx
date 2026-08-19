import { html } from "diff2html";
import { useEffect, useMemo, useState } from "react";
import { patchForFiles, unclaimedFiles } from "../../src/core/diff";
import {
  addComment,
  deleteComment,
  exportUrl,
  fetchReview,
  fetchSendPreview,
  patchComment,
  patchReview,
  sendReview,
} from "./api";
import { Markdown } from "./Markdown";
import { Artifact, Chapter, ReviewComment, SendPreview } from "./types";

function DiffBlock({ patch }: { patch: string }) {
  const rendered = useMemo(
    () =>
      patch.trim()
        ? html(patch, { drawFileList: false, matching: "lines", outputFormat: "line-by-line" })
        : "",
    [patch],
  );
  if (!rendered) return <p className="muted">No diff for this chapter.</p>;
  return <div className="diff" dangerouslySetInnerHTML={{ __html: rendered }} />;
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
  return (
    <section className="chapter">
      <h3 onClick={() => setOpen(!open)} className="chapter-title">
        {open ? "▾" : "▸"} {chapter.title}{" "}
        <span className="muted">
          ({chapter.files.length} file{chapter.files.length === 1 ? "" : "s"}
          {comments.length > 0 ? `, ${comments.length} comment${comments.length === 1 ? "" : "s"}` : ""})
        </span>
      </h3>
      {open && (
        <>
          <Markdown className="chapter-explanation" text={chapter.explanation} />
          {comments.map((c) => (
            <CommentCard
              key={c.id}
              comment={c}
              onUpdate={(p) => onUpdateComment(c.id, p)}
              onDelete={() => onDeleteComment(c.id)}
              readOnly={readOnly}
            />
          ))}
          {!readOnly && chapter.files.length > 0 && (
            <AddComment files={chapter.files} chapterId={chapter.id} onAdd={onAddComment} />
          )}
          <DiffBlock patch={patch} />
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
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSendPreview(reviewKey, event).then(setPreview).catch((e) => setError(String(e)));
    setConfirming(false);
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
      <h2>Send</h2>
      <p className="muted">
        Nothing has been sent to GitHub. Review the drafts above, then send explicitly.
        Dropped comments stay local; comments without a valid diff line are folded into the review
        body.
      </p>
      <div className="send-controls">
        <select value={event} onChange={(e) => setEvent(e.target.value)}>
          <option value="COMMENT">Comment</option>
          <option value="APPROVE">Approve</option>
          <option value="REQUEST_CHANGES">Request changes</option>
        </select>
        {preview && (
          <span className="muted">
            {preview.comments.length} inline comment{preview.comments.length === 1 ? "" : "s"}
            {preview.folded.length > 0 && <> + {preview.folded.length} folded into body</>}
          </span>
        )}
        <button onClick={() => setShowBody(!showBody)}>
          {showBody ? "hide" : "preview"} body
        </button>
        <a href={exportUrl(reviewKey)} className="export-link">
          export .md
        </a>
        {!confirming ? (
          <button className="send-btn" onClick={() => setConfirming(true)}>
            Send review to GitHub…
          </button>
        ) : (
          <span className="confirm-group">
            <strong>
              Really send {event} to {artifact.pr.owner}/{artifact.pr.repo}#{artifact.pr.number}?
            </strong>
            <button
              className="send-btn send-btn-confirm"
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
                  setConfirming(false);
                }
              }}
            >
              {sending ? "Sending…" : "Yes, send it"}
            </button>
            <button onClick={() => setConfirming(false)}>cancel</button>
          </span>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {showBody && preview && <pre className="body-preview">{preview.body}</pre>}
    </div>
  );
}

export function Detail({ reviewKey }: { reviewKey: string }) {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchReview(reviewKey).then(setArtifact).catch((e) => setError(String(e)));
  }, [reviewKey]);

  if (error) return <p className="error">{error}</p>;
  if (!artifact) return <p className="muted">Loading…</p>;

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
        {artifact.run?.costUsd != null && <> · review cost ${artifact.run.costUsd.toFixed(2)}</>} ·
        status: <strong>{artifact.status}</strong>
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
          <button onClick={() => apply(patchReview(reviewKey, { status: "reviewed" }))}>
            mark reviewed
          </button>{" "}
          <button onClick={() => apply(patchReview(reviewKey, { status: "skipped" }))}>skip</button>
        </p>
      )}
    </div>
  );
}
