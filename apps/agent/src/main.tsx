import "@brainstorm/editor/editor-theme.css";
import "@brainstorm/sdk/app-theme.css";
import "@brainstorm/sdk/composer-context.css";
import "@brainstorm/sdk/empty-state.css";
import "@brainstorm/sdk/markdown.css";
import { AppErrorBoundary } from "@brainstorm/sdk/error-boundary";
import { mountMenuHost } from "@brainstorm/sdk/menus";
import { getWidgetLaunch } from "@brainstorm/sdk/widget";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AgentApp } from "./app";
import "./styles.css";
import { AgentWidget } from "./widget";

const root = document.getElementById("root");
if (!root) throw new Error("Agent: #root not found in index.html");
// Stand up the shared fancy-menus runtime (object / context menus).
mountMenuHost();

// Widget-mode: the dashboard launched this bundle as a widget. Mount the
// compact recent-conversations glance list instead of the full Agent app.
const widgetLaunch = getWidgetLaunch();
if (widgetLaunch) {
	createRoot(root).render(
		<StrictMode>
			<AppErrorBoundary appName="agent">
				<AgentWidget launch={widgetLaunch} />
			</AppErrorBoundary>
		</StrictMode>,
	);
} else {
	createRoot(root).render(
		<StrictMode>
			<AppErrorBoundary appName="agent">
				<AgentApp />
			</AppErrorBoundary>
		</StrictMode>,
	);
}
