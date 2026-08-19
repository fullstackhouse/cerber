import { useEffect, useState } from "react";
import { Detail } from "./Detail";
import { Key } from "./Icon";
import { Queue } from "./Queue";
import { Settings } from "./Settings";

function parseHash(): { view: "queue" } | { view: "settings" } | { view: "detail"; key: string } {
  const hash = window.location.hash;
  const m = hash.match(/^#\/r\/(.+)$/);
  if (m) return { view: "detail", key: decodeURIComponent(m[1]!) };
  if (hash === "#/settings") return { view: "settings" };
  return { view: "queue" };
}

export function App() {
  const [route, setRoute] = useState(parseHash());

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
          <a href="#/settings" className="topbar-link">
            settings
          </a>
        </div>
      </header>
      {route.view === "queue" ? <Queue /> : <Settings />}
    </div>
  );
}
