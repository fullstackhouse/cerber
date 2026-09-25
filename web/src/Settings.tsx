import { useEffect, useState } from "react";
import { fetchConfig, updateCockpitConfig, updateDaemonConfig, updateTrustRule } from "./api";
import { NotifyState, useNotifyState } from "./notify";
import { ThemeChoice, useTheme } from "./theme";
import { ConfigView } from "./types";

const EXAMPLES = [
  { rule: "@acme/*", meaning: "anyone in the acme org" },
  { rule: "@acme/devs", meaning: "anyone on that GitHub team" },
  { rule: "@teammate", meaning: "one person, by login" },
  { rule: "!@acme/contractors", meaning: "deny — beats every rule above" },
];

/** Rule errors carry the guidance a person needs — show it, not "Error: ...". */
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The checkbox says what ticking it does — including when it can't. */
const NOTIFY_LABEL: Record<NotifyState, string> = {
  unsupported: "this browser has no notifications to give",
  blocked: "this browser has blocked notifications for cerber",
  off: "tell me when a review is ready for me",
  ask: "tell me when a review is ready for me (the browser will ask first)",
  on: "tell me when a review is ready for me",
};

const THEMES: { choice: ThemeChoice; label: string }[] = [
  { choice: "system", label: "follow this machine" },
  { choice: "light", label: "light" },
  { choice: "dark", label: "dark" },
];

export function Settings({ daemonAnnounces }: { daemonAnnounces: boolean }) {
  const [notify, toggleNotify] = useNotifyState();
  const [theme, setTheme] = useTheme();
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchConfig().then(setConfig).catch((e) => setError(message(e)));
  }, []);

  const apply = (p: Promise<ConfigView>) => {
    setBusy(true);
    setError(null);
    p.then(setConfig)
      .catch((e) => setError(message(e)))
      .finally(() => setBusy(false));
  };

  if (error && !config) return <p className="error">{error}</p>;
  if (!config) return <p className="muted">Loading…</p>;

  return (
    <div className="settings">
      <a href="#/" className="back">
        ← queue
      </a>
      <h1>Inbox</h1>
      <p>
        By default cerber keeps the queue itself: it polls GitHub for PRs awaiting your review and
        drafts a review for each, so they're ready when you open the cockpit. Nothing is ever sent
        without you. Changes apply on the next poll — no restart.
      </p>
      <label className="inbox-toggle">
        <input
          type="checkbox"
          checked={config.daemon.poll}
          disabled={busy}
          onChange={(e) => apply(updateDaemonConfig({ poll: e.target.checked }))}
        />{" "}
        poll GitHub for PRs awaiting my review (every {config.daemon.intervalMinutes}m)
      </label>
      <label className="inbox-toggle">
        <input
          type="checkbox"
          checked={config.daemon.autoReview}
          disabled={busy || !config.daemon.poll}
          onChange={(e) => apply(updateDaemonConfig({ autoReview: e.target.checked }))}
        />{" "}
        draft a review automatically (off: awaiting PRs wait for a click)
      </label>
      <p className="muted">
        Interval, concurrency and a repo filter live in <code>{config.path}</code> under{" "}
        <code>daemon</code> — hand-editable, like everything here.
      </p>

      <h1>Notifications</h1>
      <p>
        When a PR is worth coming back for, cerber says so: one desktop notification per poll. With
        auto-review on that moment is the draft landing, not the PR arriving — a tap that leads to
        "no run yet" costs you the walk back and gives you nothing — and the notification names
        what the review found. A PR nobody is drafting (auto-review off, or a run that failed) is
        announced as it lands, since that is all the news there will be — and if a retry then
        drafts it after all, that is new news and you are told. Several at once fold into one
        notification, and a PR whose draft has been announced never arrives twice, however its
        next re-review ends.
      </p>
      <label className="inbox-toggle">
        <input
          type="checkbox"
          checked={config.daemon.notify}
          disabled={busy || !config.daemon.poll}
          onChange={(e) => apply(updateDaemonConfig({ notify: e.target.checked }))}
        />{" "}
        tell this machine when a review is ready for you (no cockpit tab required)
      </label>
      <p className="muted">
        This is the one that works while you're somewhere else: it rides the poll, so it needs
        nothing open but <code>serve</code> itself. It hands the notification to
        whatever this machine already has — Notification Centre on macOS,{" "}
        <code>notify-send</code> on Linux — and stays quiet where there is neither. On macOS it{" "}
        <strong>opens that review when you click it</strong>, through a small app cerber builds
        for the job (the first one asks you to allow notifications from "Cerber"); a{" "}
        <code>notify-send</code> tap announces the PR but has no click to give.
      </p>
      <label className="inbox-toggle">
        <input
          type="checkbox"
          checked={notify === "on"}
          disabled={
            notify === "unsupported" || notify === "blocked" || daemonAnnounces
          }
          onChange={toggleNotify}
        />{" "}
        {daemonAnnounces ? "let this browser announce them instead" : NOTIFY_LABEL[notify]}
      </label>
      <p className="muted">
        {daemonAnnounces ? (
          <>
            Standing down while the machine's own notification is on — two popups for one PR is
            one too many. Untick the machine one above and this browser takes over: it names the
            PR and opens that review on click just the same, but only while a cockpit tab is open
            and this browser has granted the permission.
          </>
        ) : (
          <>
            Per-browser, not per-machine: the permission belongs to this browser, so the switch
            lives here rather than in <code>{config.path}</code>. Granting it is the browser's
            prompt, not cerber's — a browser that has blocked cerber has to be un-blocked from the
            padlock next to the address bar. Nothing is announced while you're looking straight at
            the cockpit.
          </>
        )}
      </p>

      <h1>Appearance</h1>
      {THEMES.map(({ choice, label }) => (
        <label key={choice} className="inbox-toggle">
          <input
            type="radio"
            name="theme"
            checked={theme === choice}
            onChange={() => setTheme(choice)}
          />{" "}
          {label}
        </label>
      ))}
      <p className="muted">
        Per-browser, like the notification switch: it's about this screen, not your reviews, so it
        lives here rather than in <code>{config.path}</code>.
      </p>

      <h1>Review page</h1>
      <label className="inbox-toggle">
        <input
          type="checkbox"
          checked={config.cockpit.stickyChapters}
          disabled={busy}
          onChange={(e) => apply(updateCockpitConfig({ stickyChapters: e.target.checked }))}
        />{" "}
        keep the chapter title pinned while scrolling through it
      </label>
      <p className="muted">
        Ten files into a chapter you still see which one you're in, and the pinned title can open
        the chapter's explanation. Stored in <code>{config.path}</code> under <code>cockpit</code>.
      </p>

      <h1>Trusted PRs</h1>

      <p>
        Every review reads the PR's code. A <strong>trusted</strong> review may also run it — the
        test that covers the change, a typecheck, <code>git log</code> — so it can report what
        happened instead of guessing. That means executing code from the PR on this machine, the
        same as checking the branch out and running the tests yourself.
      </p>
      <p className="muted">
        Trust the people, not the code: nothing about a PR can earn it. Rules live in{" "}
        <code>{config.path}</code>.
      </p>
      <p className="muted">
        Only people can be trusted — there is no way to trust a repository. Anyone can open a PR
        against a repo you own, so trusting the repo would trust them too. Membership is checked
        against GitHub when the review runs, and a check that fails counts as "not a member".
      </p>

      <div className="trust-add">
        <input
          value={draft}
          aria-label="Trust rule"
          placeholder="@org/*, @org/team, @login, !deny"
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // The button is disabled while a write is in flight; Enter has to
            // honour that too, or it posts the same rule twice.
            if (e.key === "Enter" && !busy && draft.trim()) {
              apply(updateTrustRule(draft.trim()));
              setDraft("");
            }
          }}
        />
        <button
          className="btn"
          disabled={busy || !draft.trim()}
          onClick={() => {
            apply(updateTrustRule(draft.trim()));
            setDraft("");
          }}
        >
          trust
        </button>
      </div>
      {error && <p className="error">{error}</p>}

      {config.trust.length === 0 ? (
        <p className="muted">
          Nobody is trusted yet — every review reads the checkout and runs nothing.
        </p>
      ) : (
        <table className="trust-table">
          <tbody>
            {config.trust.map((entry) => (
              <tr key={entry.rule} className={entry.denies ? "trust-deny" : undefined}>
                <td>
                  <code>{entry.rule}</code>
                </td>
                <td className="muted">{entry.explanation}</td>
                <td className="trust-actions">
                  <button className="btn" disabled={busy} onClick={() => apply(updateTrustRule(entry.rule, true))}>
                    remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Rule syntax</h2>
      <table className="trust-table">
        <tbody>
          {EXAMPLES.map((e) => (
            <tr key={e.rule}>
              <td>
                <code>{e.rule}</code>
              </td>
              <td className="muted">{e.meaning}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="muted">
        A trusted review is handed no GitHub credentials — no token, no <code>gh</code> login, no
        git or ssh identity — so a push fails to authenticate rather than being merely discouraged.
        It is not a sandbox though: it has <code>Bash</code> and this machine, so trust people you
        would let run their branch here anyway.
        The daemon reviews unattended, so with rules set it runs matching PRs' code with nobody
        watching — start it with <code>--no-trust</code> to prevent that.
      </p>
    </div>
  );
}
