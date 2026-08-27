import { createRoot } from "react-dom/client";
import { AppRoutes } from "./routes.js";
import "@brett_lamy/docstream/styles.css";
import "@brett_lamy/ui/styles.css";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("missing application root");
createRoot(root).render(<AppRoutes />);
