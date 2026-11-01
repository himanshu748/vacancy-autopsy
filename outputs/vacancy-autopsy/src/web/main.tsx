import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SharedFindingPage } from "./SharedFinding";
const sharedId = new URLSearchParams(window.location.search).get("shared");
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {sharedId !== null ? <SharedFindingPage id={sharedId} /> : <App />}
  </React.StrictMode>,
);
