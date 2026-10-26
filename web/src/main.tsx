import { LocaleProvider } from "./i18n";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./style.css";

export type { Workspace } from "./app/types";

createRoot(document.getElementById("root")!).render(
  <LocaleProvider>
    <App />
  </LocaleProvider>,
);
