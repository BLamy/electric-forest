import { createRoot } from "react-dom/client";
import { AppRoutes } from "./routes.js";
// One copy each: @brett_lamy/ui@2.0.0 imports the same @brett_lamy/docstream@1.5.0 sheet.
import "@brett_lamy/ui/styles.css";
import "@brett_lamy/docstream/styles.css";
import "@brett_lamy/docstream-editor/styles.css";
import "./styles/app.css";

const root = document.getElementById("root");
if (root === null) throw new Error("missing application root");
createRoot(root).render(<AppRoutes />);
