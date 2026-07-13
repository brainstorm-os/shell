import "@brainstorm/sdk/app-theme.css";
import { initAnalytics } from "@brainstorm/sdk/analytics";
import "@brainstorm/sdk/recurrence-editor.css";
import { AppErrorBoundary } from "@brainstorm/sdk/error-boundary";
import { mountMenuHost } from "@brainstorm/sdk/menus";
import { getWidgetLaunch } from "@brainstorm/sdk/widget";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CalendarApp } from "./app";
import { CalendarWidget } from "./widget";
import "./styles.css";

// Stand up the fancy-menus runtime so object / context / anchored menus open
// through the shared bridge (matches the other React apps' main.tsx).
mountMenuHost();

initAnalytics();

const root = document.getElementById("root");
if (!root) throw new Error("[calendar] #root not found in index.html");

// Widget-mode (Stage 7.3a): the dashboard launched this bundle as a widget.
// Mount the compact widget surface instead of the full calendar app.
const widgetLaunch = getWidgetLaunch();
if (widgetLaunch) {
	createRoot(root).render(
		<StrictMode>
			<AppErrorBoundary appName="calendar">
				<CalendarWidget launch={widgetLaunch} />
			</AppErrorBoundary>
		</StrictMode>,
	);
} else {
	createRoot(root).render(
		<StrictMode>
			<AppErrorBoundary appName="calendar">
				<CalendarApp />
			</AppErrorBoundary>
		</StrictMode>,
	);
}
