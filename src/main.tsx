import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/nunito/400.css";
import "@fontsource/nunito/600.css";
import "@fontsource/nunito/700.css";
import "@fontsource/nunito/800.css";
import "@fontsource/nunito/900.css";
// Readable font option (#34); the files only load once Settings turns it on.
import "@fontsource/atkinson-hyperlegible-next/400.css";
import "@fontsource/atkinson-hyperlegible-next/600.css";
import "@fontsource/atkinson-hyperlegible-next/700.css";
import "@fontsource/atkinson-hyperlegible-next/800.css";
import "./styles.css";
import "./i18n";
import "./theme";
import { AppProvider } from "./store";
import App from "./App";
import { isCompanion, isWeb } from "./db";
import { registerOfflinePage } from "./companion";

if (isCompanion && !isWeb) registerOfflinePage();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>,
);
