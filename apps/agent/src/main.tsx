import "@brainstorm-os/editor/editor-theme.css";
import { initAnalytics } from "@brainstorm-os/sdk/analytics";
import "@brainstorm-os/sdk/app-theme.css";
import "@brainstorm-os/sdk/composer-context.css";
import "@brainstorm-os/sdk/empty-state.css";
import "@brainstorm-os/sdk/markdown.css";
import { AppErrorBoundary } from "@brainstorm-os/sdk/error-boundary";
import { mountMenuHost } from "@brainstorm-os/sdk/menus";
import { getWidgetLaunch } from "@brainstorm-os/sdk/widget";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AgentApp } from "./app";
import { AgentI18nProvider } from "./i18n-provider";
import "./styles.css";
import { AgentWidget } from "./widget";

initAnalytics();

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
				<AgentI18nProvider>
					<AgentWidget launch={widgetLaunch} />
				</AgentI18nProvider>
			</AppErrorBoundary>
		</StrictMode>,
	);
} else {
	createRoot(root).render(
		<StrictMode>
			<AppErrorBoundary appName="agent">
				<AgentI18nProvider>
					<AgentApp />
				</AgentI18nProvider>
			</AppErrorBoundary>
		</StrictMode>,
	);
}
