import { useEffect, useRef, useState } from "react";
import { fetchDaemonStatus, fetchReviews, rerunReview } from "./api";
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
      {daemon.pollEnabled ? (
        <span>
          🟢 polling every {Math.round(daemon.intervalMs / 60_000)}m
          {daemon.repos.length > 0 ? ` (${daemon.repos.join(", ")})` : ""}
          {daemon.autoReview ? ", auto-review on" : ", auto-review off"}
        </span>
      ) : (
        <span>⏸ polling off (settings) — showing local reviews only</span>
      )}
      {daemon.trustedRuns && (
        <span title="Trust rules are set and auto-review is on: reviews of matching PRs run their code unattended. Settings → Trusted PRs, or serve --no-trust.">
          ⚡ trusted PRs run with Bash
        </span>
      )}
      <span>
        {daemon.autoSend === "on"
          ? `🤖 auto-send ON ≥${daemon.autoSendThreshold}% (${daemon.autoSent} sent)`
          : `👻 auto-send shadow ≥${daemon.autoSendThreshold}% (${daemon.autoSendCandidates} candidate${daemon.autoSendCandidates === 1 ? "" : "s"})`}
      </span>
      {daemon.polling && <span>⏳ polling now…</span>}
      {daemon.lastPollError && (
        <span className="error" title={daemon.lastPollError}>
          ⚠ discovery offline — showing local reviews only
        </span>
      )}
      {daemon.lastSummary && !daemon.lastPollError && <span className="muted">last: {daemon.lastSummary}</span>}
      {daemon.nextPollAt && !daemon.polling && (
        <span className="muted">next: {new Date(daemon.nextPollAt).toLocaleTimeString()}</span>
      )}
    </div>
  );
}

function ReviewRow({ r, onReview, reviewing }: { r: ReviewListItem; onReview: (key: string) => void; reviewing: boolean }) {
  const archived = r.pr.state && r.pr.state !== "OPEN";
  return (
    <tr className={archived ? "row-archived" : undefined}>
      <td>
        <span className={`status status-${r.status}`}>{r.status}</span>
      </td>
      <td>
        <a href={`#/r/${encodeURIComponent(r.key)}`} className="pr-link">
          {r.pr.owner}/{r.pr.repo}#{r.pr.number}
        </a>{" "}
        <span className="pr-title">{r.pr.title}</span>
        <span className="muted"> by {r.pr.author}</span>
        {archived && <span className="badge badge-muted"> {r.pr.state?.toLowerCase()}</span>}
      </td>
      <td>
        {r.status === "awaiting" ? (
          <button className="review-now" disabled={reviewing} onClick={() => onReview(r.key)}>
            {reviewing ? "starting…" : "review"}
          </button>
        ) : (
          <VerdictBadge verdict={r.verdict} />
        )}
      </td>
      <td>{r.commentCount}</td>
      <td className="muted">
        {r.pr.changedFiles > 0 ? (
          <>
            {r.pr.changedFiles}f <span className="add">+{r.pr.additions}</span>{" "}
            <span className="del">-{r.pr.deletions}</span>
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="muted">{new Date(r.updatedAt).toLocaleString()}</td>
    </tr>
  );
}

export function Queue() {
  const [reviews, setReviews] = useState<ReviewListItem[] | null>(null);
  const [daemon, setDaemon] = useState<DaemonStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [starting, setStarting] = useState<Set<string>>(new Set());

  // Fetches outlive the component; never set state after unmount.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = () => {
    fetchReviews()
      .then((r) => alive.current && setReviews(r))
      .catch((e) => alive.current && setError(String(e)));
    fetchDaemonStatus()
      .then((d) => alive.current && setDaemon(d))
      .catch(() => {});
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startReview = (key: string) => {
    setStarting((s) => new Set(s).add(key));
    rerunReview(key)
      .then(() => load())
      .catch((e) => alive.current && setError(String(e)))
      .finally(() => {
        if (!alive.current) return;
        setStarting((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        });
      });
  };

  if (error && !reviews) return <p className="error">{error}</p>;
  if (!reviews) return <p className="muted">Loading…</p>;

  const active = reviews.filter((r) => !r.pr.state || r.pr.state === "OPEN");
  const archived = reviews.filter((r) => r.pr.state && r.pr.state !== "OPEN");

  const sort = (list: ReviewListItem[]) =>
    [...list].sort(
      (a, b) =>
        STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );

  const counts = active.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  // Only the rows the stats describe — archived reviews' spend is history.
  const totalCost = active.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);

  const table = (rows: ReviewListItem[]) => (
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
        {rows.map((r) => (
          <ReviewRow key={r.key} r={r} onReview={startReview} reviewing={starting.has(r.key)} />
        ))}
      </tbody>
    </table>
  );

  return (
    <>
      <DaemonStrip daemon={daemon} />
      {error && <p className="error">{error}</p>}
      {active.length === 0 ? (
        <div className="empty">
          {daemon?.enabled ? (
            <p>
              Inbox empty — nothing awaits your review.
              {daemon.lastPollError ? " (Discovery is offline; check gh auth.)" : ""}
            </p>
          ) : (
            <>
              <p>No reviews yet.</p>
              <pre>cerber review https://github.com/owner/repo/pull/123</pre>
            </>
          )}
        </div>
      ) : (
        <>
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
          {table(sort(active))}
        </>
      )}
      {archived.length > 0 && (
        <div className="archived">
          <button className="archived-toggle" onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? "▾" : "▸"} archived — {archived.length} merged/closed PR
            {archived.length === 1 ? "" : "s"}
          </button>
          {showArchived && table(sort(archived))}
        </div>
      )}
    </>
  );
}
