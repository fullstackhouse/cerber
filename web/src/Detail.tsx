import { html } from "diff2html";
import { useEffect, useMemo, useState } from "react";
import { patchForFiles, unclaimedFiles } from "../../src/core/diff";
import { fetchReview } from "./api";
import { Artifact, Chapter, ReviewComment } from "./types";

function DiffBlock({ patch }: { patch: string }) {
  const rendered = useMemo(
    () =>
      patch.trim()
        ? html(patch, {
            drawFileList: false,
            matching: "lines",
            outputFormat: "line-by-line",
          })
        : "",
    [patch],
  );
  if (!rendered) return <p className="muted">No diff for this chapter.</p>;
  return <div className="diff" dangerouslySetInnerHTML={{ __html: rendered }} />;
}

function CommentCard({ comment }: { comment: ReviewComment }) {
  return (
    <div className={`comment comment-${comment.status}`}>
      <div className="comment-loc">
        {comment.path}
        {comment.line != null ? `:${comment.line}` : ""} <span className="muted">({comment.origin})</span>
      </div>
      <div className="comment-body">{comment.body}</div>
    </div>
  );
}

function ChapterSection({
  chapter,
  diff,
  comments,
}: {
  chapter: Chapter;
  diff: string;
  comments: ReviewComment[];
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
          <p className="chapter-explanation">{chapter.explanation}</p>
          {comments.map((c) => (
            <CommentCard key={c.id} comment={c} />
          ))}
          <DiffBlock patch={patch} />
        </>
      )}
    </section>
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
        {artifact.run?.costUsd != null && <> · review cost ${artifact.run.costUsd.toFixed(2)}</>}
      </p>

      {artifact.verdict && (
        <div className={`verdict verdict-${artifact.verdict.recommendation}`}>
          <strong>{artifact.verdict.recommendation.replace("_", " ")}</strong> · confidence{" "}
          {artifact.verdict.confidence}%
          <p>{artifact.verdict.reasoning}</p>
        </div>
      )}

      {artifact.run?.error && <div className="error">Run failed: {artifact.run.error}</div>}

      <section className="summary">
        <h2>Summary</h2>
        <div className="summary-body">{artifact.summary || "(no summary)"}</div>
      </section>

      <h2>Walkthrough</h2>
      {artifact.chapters.map((ch) => (
        <ChapterSection
          key={ch.id}
          chapter={ch}
          diff={artifact.diff}
          comments={artifact.comments.filter((c) => c.chapterId === ch.id)}
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
        />
      )}

      {orphanComments.length > 0 && (
        <section className="chapter">
          <h3>Unattached comments</h3>
          {orphanComments.map((c) => (
            <CommentCard key={c.id} comment={c} />
          ))}
        </section>
      )}
    </div>
  );
}
