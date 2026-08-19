import { useEffect, useState } from "react";
import { Detail } from "./Detail";
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

  return (
    <div className="app">
      <header className="topbar">
        <a href="#/" className="brand">
          🐕 cerber
        </a>
        <span className="tagline">nothing reaches GitHub until you say so</span>
        <a href="#/settings" className="topbar-link">
          settings
        </a>
      </header>
      {route.view === "queue" ? (
        <Queue />
      ) : route.view === "settings" ? (
        <Settings />
      ) : (
        <Detail reviewKey={route.key} />
      )}
    </div>
  );
}
