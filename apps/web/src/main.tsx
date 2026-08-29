import { createRoot } from "react-dom/client";
import { AppRoutes } from "./routes.js";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("missing application root");
createRoot(root).render(<AppRoutes />);
