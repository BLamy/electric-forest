import { createRoot } from "react-dom/client";
import * as React from "react";
import { AppRoutes } from "./routes.js";
import "@brett_lamy/docstream/styles.css";
import "@brett_lamy/ui/styles.css";
import "./styles.css";

// Docstream 0.3.7's published ESM renders through the classic React global.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const root = document.getElementById("root");
if (root === null) throw new Error("missing application root");
createRoot(root).render(<AppRoutes />);
