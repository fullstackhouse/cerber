import { useEffect, useState } from "react";
import { fetchConfig, updateTrustRule } from "./api";
import { ConfigView } from "./types";

const EXAMPLES = [
  { rule: "@acme/*", meaning: "anyone in the acme org" },
  { rule: "@acme/devs", meaning: "anyone on that GitHub team" },
  { rule: "@teammate", meaning: "one person, by login" },
  { rule: "!@acme/contractors", meaning: "deny — beats every rule above" },
];

/** Rule errors carry the guidance a person needs — show it, not "Error: ...". */
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Settings() {
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
                <td>
                  <button disabled={busy} onClick={() => apply(updateTrustRule(entry.rule, true))}>
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
