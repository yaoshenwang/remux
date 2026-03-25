import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@xterm/xterm/css/xterm.css";
import "./styles/app.css";

createRoot(document.getElementById("root")!).render(<App />);
