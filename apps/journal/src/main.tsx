import "@brainstorm-os/sdk/app-theme.css";
import { initAnalytics } from "@brainstorm-os/sdk/analytics";
import { AppErrorBoundary } from "@brainstorm-os/sdk/error-boundary";
import { getWidgetLaunch } from "@brainstorm-os/sdk/widget";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { JournalApp } from "./app";
import "./types";
import "./styles.css";
import { JournalWidget } from "./widget";

initAnalytics();

const root = document.getElementById("journal-root");
if (!root) throw new Error("journal: #journal-root missing");

document.body.classList.remove("is-booting");

// Widget-mode: the dashboard launched this bundle as a widget. Mount the
// compact today-journal glance instead of the full Journal app.
const widgetLaunch = getWidgetLaunch();
if (widgetLaunch) {
	createRoot(root).render(
		<StrictMode>
			<AppErrorBoundary appName="journal">
				<JournalWidget launch={widgetLaunch} />
			</AppErrorBoundary>
		</StrictMode>,
	);
} else {
	createRoot(root).render(
		<StrictMode>
			<AppErrorBoundary appName="journal">
				<JournalApp />
			</AppErrorBoundary>
		</StrictMode>,
	);
}
