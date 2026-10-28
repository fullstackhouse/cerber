import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { followOtherTabs } from "./theme";
import "diff2html/bundles/css/diff2html.min.css";
import "./styles.css";

followOtherTabs();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
