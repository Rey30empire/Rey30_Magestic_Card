import React from "react";
import { createRoot } from "react-dom/client";
import EditorRoot from "./editor/EditorRoot";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <EditorRoot />
  </React.StrictMode>
);
