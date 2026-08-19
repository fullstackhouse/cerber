import { useEffect, useState } from "react";
import { Detail } from "./Detail";
import { Queue } from "./Queue";

function parseHash(): { view: "queue" } | { view: "detail"; key: string } {
  const hash = window.location.hash;
  const m = hash.match(/^#\/r\/(.+)$/);
  if (m) return { view: "detail", key: decodeURIComponent(m[1]!) };
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
      </header>
      {route.view === "queue" ? <Queue /> : <Detail reviewKey={route.key} />}
    </div>
  );
}
