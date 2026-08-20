import { useEffect, useMemo, useRef, useState } from "react";
import { createReview, fetchDaemonStatus, fetchReviews, patchReview, rerunReview } from "./api";
import { Icon, Key } from "./Icon";
import {
  FILED_TABS,
  INBOX_TABS,
  TAB_META,
  Tab,
  ageLabel,
  bucket,
  hiddenAwaitingNote,
  isHiddenAwaiting,
  replyOf,
  replyTag,
  rowTag,
  shownTab,
  strip,
  verdictCell,
} from "./inbox";
import { DaemonStatus, Reply, ReviewListItem } from "./types";

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

/**
 * One row shape for every tab. What you already dealt with used to render
 * through a second, thinner component in a drawer — same PR, different columns,
 * no cursor. A filed review is the same row; the tags say what became of it.
 */
function Row({
  r,
  selected,
  onSelect,
  onOpen,
  awaiting,
}: {
  r: ReviewListItem;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  /** Whose move it is on GitHub, when GitHub still asks you for this one. */
  awaiting?: Reply | null;
}) {
  const v = verdictCell(r);
  const tag = rowTag(r);
  const request = awaiting ? replyTag(awaiting) : null;
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
      <span className="col-author" title={r.pr.author}>
        {r.pr.author}
      </span>
      <span className="col-title" title={r.pr.title}>
        {r.pr.title}
      </span>
      {r.pr.isDraft && (
        <span className="tag tag-draft" title="Still a draft — its author asked for your review anyway">
          draft
        </span>
      )}
      {request && (
        <span className="tag tag-awaiting" title={request.title}>
          {request.label}
        </span>
      )}
      {tag && <span className="tag tag-done">{tag}</span>}
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
      <span className={`col-verdict tone-${v.tone}`}>{v.label}</span>
      <span className="col-age">{ageLabel(r.updatedAt)}</span>
    </div>
  );
}

/**
 * The other way in. The inbox only knows what GitHub asks you to review; this
 * takes anything — your own PR, one you were never requested on, a draft a
 * colleague linked you. Pasting starts the review straight away rather than
 * parking it: a queued-but-unreviewed PR nobody requested is exactly what the
 * daemon's reaper cleans up, and waiting to be told twice is a click for nothing.
 */
function PullBox({ autoFocus }: { autoFocus?: boolean }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = input.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    createReview(value)
      .then((r) => openReview(r.key))
      .catch((err) => {
        setError(String(err instanceof Error ? err.message : err));
        setBusy(false);
      });
  };

  return (
    <form className="pull" onSubmit={submit}>
      {/* At rest the strip should say "you can add one", not "fill in this
          field" — the plus carries that, so the input needs no border until
          it's actually being used. */}
      <Icon name="plus" />
      <input
        className="pull-input"
        value={input}
        autoFocus={autoFocus}
        disabled={busy}
        // Clearing on edit, not on submit: an error left standing while the
        // user retypes describes a value that is no longer in the box.
        onChange={(e) => {
          setInput(e.target.value);
          if (error) setError(null);
        }}
        placeholder="paste a PR URL to review it"
        aria-label="Review any PR by URL"
      />
      {/* Nothing to submit, nothing to show. The button appears with the first
          keystroke, so at rest this is one quiet line rather than a form. */}
      {input.trim() && (
        <button className="btn btn-small" type="submit" disabled={busy}>
          {busy ? "starting…" : "review"}
        </button>
      )}
      {error && <span className="pull-error">{error}</span>}
    </form>
  );
}

export function Queue() {
  const [reviews, setReviews] = useState<ReviewListItem[] | null>(null);
  const [daemon, setDaemon] = useState<DaemonStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<Set<string>>(new Set());
  const [picked, setTab] = useState<Tab>("inbox");
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
  // Every tab's rows in one pass. Sent and settled stay separate tabs because
  // that is the line the whole tool is drawn along: one reached GitHub, the
  // other didn't. `requests` is what GitHub still wants from you that your own
  // filing has hidden — the strip has always counted these.
  const buckets = useMemo(() => bucket(all, daemon), [all, daemon]);
  const hidden = buckets.requests;
  // Not necessarily the tab you clicked: a filed tab can empty under you.
  const tab = shownTab(picked, buckets);
  const rows = buckets[tab];

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

  // What the rows on screen cost — the figure has to be about the list it
  // sits over, not about some other tab's.
  const totalCost = rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const detail = selected ? strip(selected, daemon) : null;
  const busy = selected ? starting.has(selected.key) : false;
  // The inbox trio always shows — its counts are the triage. A filed tab
  // appears as it fills and goes as it empties: an empty one is a filter
  // nobody can want, and a fresh install should not open onto four of them.
  const filed = FILED_TABS.filter((t) => buckets[t].length > 0);
  const tabButton = (t: Tab) => (
    <button
      key={t}
      className={`tab${tab === t ? " tab-on" : ""}${FILED_TABS.includes(t) ? " tab-filed" : ""}${
        t === "requests" ? " tab-requests" : ""
      }`}
      title={TAB_META[t].title}
      onClick={() => setTab(t)}
    >
      {TAB_META[t].label} <span className="tab-count">{buckets[t].length}</span>
    </button>
  );

  return (
    <>
      <DaemonStrip daemon={daemon} />
      {error && (
        <div className="wrap">
          <p className="error">{error}</p>
        </div>
      )}

      {all.length === 0 ? (
        <div className="wrap">
          <div className="empty">
            {daemon?.enabled ? (
              <p>
                Inbox empty — nothing awaits your review.
                {daemon.lastPollError ? " (Discovery is offline; check gh auth.)" : ""}
              </p>
            ) : (
              <p>No reviews yet.</p>
            )}
            <PullBox autoFocus />
          </div>
        </div>
      ) : (
        <div className="wrap">
          {/* One filter row for every bucket: what still wants you on the left,
              what you have already dealt with on the right. */}
          <div className="tabs">
            {INBOX_TABS.map(tabButton)}
            {filed.length > 0 && <span className="tab-split" aria-hidden />}
            {filed.map(tabButton)}
            <span className="grow" />
            <PullBox />
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
            <span className="col-author">author</span>
            <span className="col-title">title</span>
            <span className="col-comments">c</span>
            <span className="col-size">size</span>
            <span className="col-verdict">verdict</span>
            <span className="col-age">upd</span>
          </div>

          {rows.length === 0 ? (
            <div className="empty-tab">
              {tab === "inbox" && hidden.length > 0 ? (
                // Never "nothing awaits your review" over the top of a poll that
                // just counted some: say how many, and point at the tab they are in.
                <>
                  <p>{hiddenAwaitingNote(hidden)}</p>
                  <button className="btn" onClick={() => setTab("requests")}>
                    <Icon name="arrowRight" />
                    show {hidden.length === 1 ? "it" : `all ${hidden.length}`}
                  </button>
                </>
              ) : (
                <p className="muted">
                  {tab === "inbox"
                    ? `Inbox empty — nothing awaits your review.${
                        daemon?.enabled && daemon.lastPollError
                          ? " (Discovery is offline; check gh auth.)"
                          : ""
                      }`
                    : `Nothing ${TAB_META[tab].label} right now.`}
                </p>
              )}
            </div>
          ) : (
            rows.map((r) => (
              <Row
                key={r.key}
                r={r}
                selected={r.key === selected?.key}
                onSelect={() => setCursor(r.key)}
                onOpen={() => openReview(r.key)}
                awaiting={isHiddenAwaiting(r, hidden) ? replyOf(r, daemon) : null}
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
    </>
  );
}
