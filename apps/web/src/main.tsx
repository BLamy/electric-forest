import { createRoot } from "react-dom/client";
import { AppRoutes } from "./routes.js";
import { HostedNotice, PreviewNotice } from "./preview.js";
// One copy each: @brett_lamy/ui@2.0.0 imports the same @brett_lamy/docstream@1.5.0 sheet.
import "@brett_lamy/ui/styles.css";
import "@brett_lamy/docstream/styles.css";
import "@brett_lamy/docstream-editor/styles.css";
import "./styles/app.css";

const root = document.getElementById("root");
if (root === null) throw new Error("missing application root");
createRoot(root).render(
  <div className="flex h-full min-h-0 flex-col">
    <PreviewNotice />
    <HostedNotice />
    <div className="min-h-0 flex-1">
      <AppRoutes />
    </div>
  </div>,
);
