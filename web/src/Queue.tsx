import { useEffect, useMemo, useRef, useState } from "react";
import { fetchDaemonStatus, fetchReviews, patchReview, rerunReview } from "./api";
import { Icon, Key } from "./Icon";
import { Tab, TABS, ageLabel, isArchived, sortReviews, strip, tabOf, verdictCell } from "./inbox";
import { DaemonStatus, ReviewListItem } from "./types";

const openReview = (key: string) => {
  window.location.hash = `#/r/${encodeURIComponent(key)}`;
};

/** True while the user is typing — keyboard shortcuts stay out of the way. */
function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  const tag = el?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable === true;
}

function DaemonStrip({ daemon }: { daemon: DaemonStatus | null }) {
  if (!daemon?.enabled) return null;
  return (
    <div className="daemon-bar">
      <div className="bar-inner">
        {daemon.pollEnabled ? (
          <span className="daemon-live">
            <span className="dot" />
            {daemon.repos.length > 0 ? daemon.repos.join(", ") : "PRs awaiting you"} · every{" "}
            {Math.round(daemon.intervalMs / 60_000)}m
          </span>
        ) : (
          <span className="daemon-live">
            <span className="dot dot-off" />
            polling off (settings) — local reviews only
          </span>
        )}
        <span>
          auto-review <b>{daemon.autoReview ? "on" : "off"}</b>
        </span>
        <span>
          auto-send <b>{daemon.autoSend === "on" ? "on" : "shadow"}</b> ≥{daemon.autoSendThreshold}%
          {daemon.autoSend === "on"
            ? ` · ${daemon.autoSent} sent`
            : ` · ${daemon.autoSendCandidates} candidate${daemon.autoSendCandidates === 1 ? "" : "s"}`}
        </span>
        {daemon.trustedRuns && (
          <span
            className="warn"
            title="Trust rules are set and auto-review is on: reviews of matching PRs run their code unattended. Settings → Trusted PRs, or serve --no-trust."
          >
            <Icon name="zap" size={12} /> trusted PRs run with Bash
          </span>
        )}
        <span className="grow" />
        {daemon.lastPollError ? (
          <span className="danger" title={daemon.lastPollError}>
            discovery offline — showing local reviews only
          </span>
        ) : (
          <span className="faint">
            {daemon.polling
              ? "polling now…"
              : [
                  daemon.lastSummary ? `last: ${daemon.lastSummary}` : null,
                  daemon.nextPollAt ? `next ${new Date(daemon.nextPollAt).toLocaleTimeString()}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
          </span>
        )}
      </div>
    </div>
  );
}

function Row({
  r,
  selected,
  onSelect,
  onOpen,
}: {
  r: ReviewListItem;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const v = verdictCell(r);
  return (
    <div
      className={`row${selected ? " row-on" : ""}`}
      // Clicking a row opens it. The strip explains whatever the pointer is
      // over on the way there, so reading a row costs nothing either.
      onClick={onOpen}
      onMouseEnter={onSelect}
      role="button"
      tabIndex={-1}
    >
      <span className="col-caret">›</span>
      {/* The column is repo#pr, not owner/repo#pr: one owner fills a queue, and
          truncating "fullstackhouse/gro…" hides the part that identifies it.
          The strip below and the tooltip still name the owner. */}
      <span className="col-slug" title={`${r.pr.owner}/${r.pr.repo}#${r.pr.number}`}>
        {r.pr.repo}#{r.pr.number}
      </span>
      <span className="col-title" title={r.pr.title}>
        {r.pr.title}
      </span>
      <span className="col-author">{r.pr.author}</span>
      <span className={`col-verdict tone-${v.tone}`}>{v.label}</span>
      <span className="col-comments">{r.commentCount || ""}</span>
      <span className="col-size">
        {r.pr.changedFiles > 0 ? (
          <>
            {r.pr.changedFiles}f <span className="add">+{r.pr.additions}</span>{" "}
            <span className="del">−{r.pr.deletions}</span>
          </>
        ) : (
          "—"
        )}
      </span>
      <span className="col-age">{ageLabel(r.updatedAt)}</span>
    </div>
  );
}

function ArchivedRow({ r }: { r: ReviewListItem }) {
  return (
    <div className="row row-archived">
      <span className="col-caret" />
      <span className="col-slug" title={`${r.pr.owner}/${r.pr.repo}#${r.pr.number}`}>
        {r.pr.repo}#{r.pr.number}
      </span>
      <span className="col-title">{r.pr.title}</span>
      <span className="col-author">{r.pr.author}</span>
      <span className="col-verdict">{r.pr.state?.toLowerCase()}</span>
      <span className="col-comments">{r.commentCount || ""}</span>
      <span className="col-size">{r.pr.changedFiles > 0 ? `${r.pr.changedFiles}f` : "—"}</span>
      <span className="col-age">{ageLabel(r.updatedAt)}</span>
    </div>
  );
}

export function Queue() {
  const [reviews, setReviews] = useState<ReviewListItem[] | null>(null);
  const [daemon, setDaemon] = useState<DaemonStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [starting, setStarting] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<Tab>("all");
  // The cursor is a review, not a row number: the list re-sorts under it every
  // poll, and the strip below must keep explaining the same PR.
  const [cursor, setCursor] = useState<string | null>(null);

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

  const all = reviews ?? [];
  const active = useMemo(() => sortReviews(all.filter((r) => !isArchived(r))), [all]);
  const archived = useMemo(() => sortReviews(all.filter(isArchived)), [all]);
  const rows = useMemo(
    () => (tab === "all" ? active : active.filter((r) => tabOf(r) === tab)),
    [active, tab],
  );
  const counts = useMemo(
    () =>
      TABS.reduce<Record<Tab, number>>(
        (acc, t) => {
          acc[t] = t === "all" ? active.length : active.filter((r) => tabOf(r) === t).length;
          return acc;
        },
        { all: 0, awaiting: 0, drafted: 0, sent: 0 },
      ),
    [active],
  );

  // Keep the cursor on a row that still exists in the current filter.
  const selected = rows.find((r) => r.key === cursor) ?? rows[0] ?? null;

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const at = rows.findIndex((r) => r.key === selected?.key);
      const move = (delta: number) => {
        const next = rows[Math.min(rows.length - 1, Math.max(0, at + delta))];
        if (next) setCursor(next.key);
      };
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "Enter" && selected) {
        openReview(selected.key);
      } else if (e.key === "r" && selected && selected.status !== "sent" && selected.status !== "running") {
        startReview(selected.key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, selected?.key]);

  if (error && !reviews) return <p className="error">{error}</p>;
  if (!reviews) return <p className="muted pad">Loading…</p>;

  // Only the rows the stats describe — archived reviews' spend is history.
  const totalCost = active.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const detail = selected ? strip(selected, daemon) : null;
  const busy = selected ? starting.has(selected.key) : false;

  return (
    <>
      <DaemonStrip daemon={daemon} />
      {error && (
        <div className="wrap">
          <p className="error">{error}</p>
        </div>
      )}

      {active.length === 0 ? (
        <div className="wrap">
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
        </div>
      ) : (
        <div className="wrap">
          <div className="tabs">
            {TABS.map((t) => (
              <button
                key={t}
                className={`tab${tab === t ? " tab-on" : ""}`}
                onClick={() => setTab(t)}
              >
                {t} <span className="tab-count">{counts[t]}</span>
              </button>
            ))}
            <span className="grow" />
            {totalCost > 0 && (
              <span
                className="faint"
                title="What these reviews would cost at API token rates. Riding a Claude subscription, they draw on your usage limits instead."
              >
                ≈${totalCost.toFixed(2)} at API rates
              </span>
            )}
          </div>

          <div className="table-head">
            <span className="col-caret" />
            <span className="col-slug">repo#pr</span>
            <span className="col-title">title</span>
            <span className="col-author">author</span>
            <span className="col-verdict">verdict</span>
            <span className="col-comments">c</span>
            <span className="col-size">size</span>
            <span className="col-age">upd</span>
          </div>

          {rows.length === 0 ? (
            <p className="muted pad">Nothing {tab} right now.</p>
          ) : (
            rows.map((r) => (
              <Row
                key={r.key}
                r={r}
                selected={r.key === selected?.key}
                onSelect={() => setCursor(r.key)}
                onOpen={() => openReview(r.key)}
              />
            ))
          )}

          {selected && detail && (
            <div className="cursor-strip">
              <div className="cursor-strip-body">
                <div className="lab">
                  {selected.pr.owner}/{selected.pr.repo}#{selected.pr.number}
                  {selected.pr.headRefName && selected.pr.baseRefName
                    ? ` · ${selected.pr.headRefName} → ${selected.pr.baseRefName}`
                    : ""}
                </div>
                <p className="prose">{detail.reasoning}</p>
                <div className="cursor-strip-meta">
                  {detail.meta.join(" · ")}
                  {selected.sent?.url && (
                    <>
                      {" · "}
                      <a href={selected.sent.url} target="_blank" rel="noreferrer">
                        view on GitHub
                      </a>
                    </>
                  )}
                </div>
              </div>
              <div className="cursor-strip-actions">
                <button className="btn-primary" onClick={() => openReview(selected.key)}>
                  <Icon name="arrowRight" />
                  open review <Key>↵</Key>
                </button>
                <div className="cursor-strip-row">
                  <button
                    className="btn"
                    disabled={selected.status === "sent" || selected.status === "skipped"}
                    title="Set the local queue status to skipped. Nothing is sent."
                    onClick={() =>
                      patchReview(selected.key, { status: "skipped" })
                        .then(load)
                        .catch((e) => setError(String(e)))
                    }
                  >
                    <Icon name="skip" />
                    skip
                  </button>
                  <button
                    className="btn"
                    disabled={busy || selected.status === "running" || selected.status === "sent"}
                    title={
                      selected.status === "sent"
                        ? "This review was sent — it is a record now."
                        : "Draft a review of the PR's current head."
                    }
                    onClick={() => startReview(selected.key)}
                  >
                    <Icon name="rerun" />
                    {busy
                      ? "starting…"
                      : selected.status === "awaiting" || selected.status === "failed"
                        ? "review now"
                        : "re-review"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {archived.length > 0 && (
        <div className="wrap">
          <div className="archived">
            <button className="archived-toggle" onClick={() => setShowArchived(!showArchived)}>
              <span className="faint">{showArchived ? "▾" : "▸"}</span> archived — {archived.length}{" "}
              merged/closed PR{archived.length === 1 ? "" : "s"}
            </button>
            {showArchived && (
              <div className="archived-rows">
                {archived.map((r) => (
                  <ArchivedRow key={r.key} r={r} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
