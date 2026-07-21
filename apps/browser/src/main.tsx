import "@brainstorm-os/sdk/app-theme.css";
import { initAnalytics } from "@brainstorm-os/sdk/analytics";
import { AppErrorBoundary } from "@brainstorm-os/sdk/error-boundary";
import { createRoot } from "react-dom/client";
import { BrowserApp } from "./app";
import { BrowserI18nProvider } from "./i18n-provider";
import "./styles.css";

initAnalytics();

const root = document.getElementById("root");
if (!root) throw new Error("Web Browser: #root not found in index.html");
// No <StrictMode> — the dev double-mount races shell-driven view attachment
// (project convention; the Browser drives an external WebContentsView).
createRoot(root).render(
	<AppErrorBoundary appName="browser">
		<BrowserI18nProvider>
			<BrowserApp />
		</BrowserI18nProvider>
	</AppErrorBoundary>,
);
