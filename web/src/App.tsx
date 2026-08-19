import { useEffect, useState } from "react";
import { Detail } from "./Detail";
import { Icon, Key, Logo } from "./Icon";
import { NotifyState, useArrivalNotifications, useNotifyState } from "./notify";
import { Queue } from "./Queue";
import { Settings } from "./Settings";

function parseHash(): { view: "queue" } | { view: "settings" } | { view: "detail"; key: string } {
  const hash = window.location.hash;
  const m = hash.match(/^#\/r\/(.+)$/);
  if (m) return { view: "detail", key: decodeURIComponent(m[1]!) };
  if (hash === "#/settings") return { view: "settings" };
  return { view: "queue" };
}

/** What the bell means right now, and what clicking it will do about that. */
const BELL_TITLE: Record<NotifyState, string> = {
  unsupported: "",
  blocked:
    "This browser blocked notifications for cerber. Turn them back on in its site settings — the padlock next to the address bar.",
  off: "Notifications off. Click to be told when a PR lands in the queue.",
  ask: "Click to be told when a PR lands in the queue — the browser will ask you first.",
  on: "Telling you when a PR lands in the queue. Click to stop.",
};

/**
 * The one switch for arrival notifications. Cerber wants them on, but only the
 * browser can grant that and only off a click — so an un-asked bell reads as
 * an offer rather than as "off".
 */
function NotifyBell() {
  const [state, toggle] = useNotifyState();
  if (state === "unsupported") return null;
  return (
    <button
      className={`topbar-link bell bell-${state}`}
      title={BELL_TITLE[state]}
      aria-label={BELL_TITLE[state]}
      aria-pressed={state === "on"}
      onClick={toggle}
    >
      <Icon name={state === "on" ? "bell" : "bellOff"} size={15} />
    </button>
  );
}

export function App() {
  const [route, setRoute] = useState(parseHash());

  // Watches the queue from every screen, including a review you have open.
  useArrivalNotifications();

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // A review carries its own top bar — the breadcrumb, which walks the queue
  // and says which keys do what there.
  if (route.view === "detail") {
    return (
      <div className="app">
        <Detail reviewKey={route.key} />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="bar-inner">
          <a href="#/" className="brand">
            <Logo />
            cerber
          </a>
          <span className="tagline">nothing reaches GitHub until you say so</span>
          <span className="grow" />
          {route.view === "queue" && (
            <>
              <span className="hint">
                <Key>j</Key>
                <Key>k</Key>move
              </span>
              <span className="hint">
                <Key>↵</Key>open
              </span>
              <span className="hint">
                <Key>r</Key>review now
              </span>
            </>
          )}
          <NotifyBell />
          <a href="#/settings" className="topbar-link" title="settings" aria-label="settings">
            <Icon name="settings" size={15} />
          </a>
        </div>
      </header>
      {route.view === "queue" ? <Queue /> : <Settings />}
    </div>
  );
}
