import { useEffect, useState } from "react";
import { fetchDaemonStatus, fetchReviews } from "./api";
import { DaemonStatus, ReviewListItem } from "./types";

const STATUS_ORDER = ["ready", "running", "awaiting", "reviewed", "failed", "sent", "skipped"];

function VerdictBadge({ verdict }: { verdict: ReviewListItem["verdict"] }) {
  if (!verdict) return <span className="badge badge-muted">—</span>;
  const cls = {
    approve: "badge-green",
    comment: "badge-yellow",
    request_changes: "badge-red",
  }[verdict.recommendation];
  return (
    <span className={`badge ${cls}`} title={verdict.reasoning}>
      {verdict.recommendation.replace("_", " ")} · {verdict.confidence}%
    </span>
  );
}

function DaemonStrip({ daemon }: { daemon: DaemonStatus | null }) {
  if (!daemon?.enabled) return null;
  return (
    <div className="daemon-strip">
      <span>
        🟢 daemon polling every {Math.round(daemon.intervalMs / 60_000)}m
        {daemon.repos.length > 0 ? ` (${daemon.repos.join(", ")})` : " (all repos)"}
      </span>
      <span>
        {daemon.autoSend === "on"
          ? `🤖 auto-send ON ≥${daemon.autoSendThreshold}% (${daemon.autoSent} sent)`
          : `👻 auto-send shadow ≥${daemon.autoSendThreshold}% (${daemon.autoSendCandidates} candidate${daemon.autoSendCandidates === 1 ? "" : "s"})`}
      </span>
      {daemon.polling && <span>⏳ polling now…</span>}
      {daemon.lastSummary && <span className="muted">last: {daemon.lastSummary}</span>}
      {daemon.nextPollAt && !daemon.polling && (
        <span className="muted">next: {new Date(daemon.nextPollAt).toLocaleTimeString()}</span>
      )}
    </div>
  );
}

export function Queue() {
  const [reviews, setReviews] = useState<ReviewListItem[] | null>(null);
  const [daemon, setDaemon] = useState<DaemonStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetchReviews()
        .then((r) => alive && setReviews(r))
        .catch((e) => alive && setError(String(e)));
      fetchDaemonStatus()
        .then((d) => alive && setDaemon(d))
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!reviews) return <p className="muted">Loading…</p>;
  if (reviews.length === 0)
    return (
      <div className="empty">
        <p>No reviews yet.</p>
        <pre>cerber review https://github.com/owner/repo/pull/123</pre>
      </div>
    );

  const sorted = [...reviews].sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );

  const counts = reviews.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const totalCost = reviews.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);

  return (
    <>
      <DaemonStrip daemon={daemon} />
      <div className="queue-stats">
        {STATUS_ORDER.filter((s) => counts[s]).map((s) => (
          <span key={s} className={`status status-${s}`}>
            {s}: {counts[s]}
          </span>
        ))}
        {totalCost > 0 && (
          <span
            className="muted"
            title="What these reviews would cost at API token rates. Riding a Claude subscription, they draw on your usage limits instead."
          >
            ≈${totalCost.toFixed(2)} at API rates
          </span>
        )}
      </div>
      <table className="queue">
      <thead>
        <tr>
          <th>Status</th>
          <th>PR</th>
          <th>Verdict</th>
          <th>Comments</th>
          <th>Size</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
          <tr key={r.key}>
            <td>
              <span className={`status status-${r.status}`}>{r.status}</span>
            </td>
            <td>
              <a href={`#/r/${encodeURIComponent(r.key)}`} className="pr-link">
                {r.pr.owner}/{r.pr.repo}#{r.pr.number}
              </a>{" "}
              <span className="pr-title">{r.pr.title}</span>
              <span className="muted"> by {r.pr.author}</span>
            </td>
            <td>
              <VerdictBadge verdict={r.verdict} />
            </td>
            <td>{r.commentCount}</td>
            <td className="muted">
              {r.pr.changedFiles}f <span className="add">+{r.pr.additions}</span>{" "}
              <span className="del">-{r.pr.deletions}</span>
            </td>
            <td className="muted">{new Date(r.updatedAt).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
      </table>
    </>
  );
}
