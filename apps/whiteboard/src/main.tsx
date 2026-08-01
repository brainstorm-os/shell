import "@brainstorm-os/sdk/app-theme.css";
import "@brainstorm-os/sdk/empty-state.css";
import { initAnalytics } from "@brainstorm-os/sdk/analytics";
import { AppErrorBoundary } from "@brainstorm-os/sdk/error-boundary";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WhiteboardApp } from "./app";
import { WhiteboardI18nProvider } from "./i18n-provider";
import "./styles.css";

initAnalytics();

const root = document.getElementById("root");
if (!root) throw new Error("whiteboard: #root not found in index.html");
createRoot(root).render(
	<StrictMode>
		<AppErrorBoundary appName="whiteboard">
			<WhiteboardI18nProvider>
				<WhiteboardApp />
			</WhiteboardI18nProvider>
		</AppErrorBoundary>
	</StrictMode>,
);
