import { useEffect, useState } from "react";
import { fetchReviews } from "./api";
import { ReviewListItem } from "./types";

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

export function Queue() {
  const [reviews, setReviews] = useState<ReviewListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchReviews()
        .then((r) => alive && setReviews(r))
        .catch((e) => alive && setError(String(e)));
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

  return (
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
  );
}
