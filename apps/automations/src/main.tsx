import "@brainstorm/sdk/app-theme.css";
import "@brainstorm/sdk/empty-state.css";
import { AppErrorBoundary } from "@brainstorm/sdk/error-boundary";
import { mountMenuHost } from "@brainstorm/sdk/menus";
import { getWidgetLaunch } from "@brainstorm/sdk/widget";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AutomationsApp } from "./app";
import { AutomationsI18nProvider } from "./i18n-provider";
import "./styles.css";
import { AutomationsWidget } from "./widget";

const root = document.getElementById("root");
if (!root) throw new Error("automations: #root not found in index.html");

document.body.classList.remove("is-booting");

// Stand up the fancy-menus runtime so the per-row ⋯ overflow + the header
// overflow menus resolve the published store and render themed surfaces.
mountMenuHost();

// Widget-mode: the dashboard launched this bundle as a widget. Mount the
// compact recent-runs glance list instead of the full Automations app.
const widgetLaunch = getWidgetLaunch();
if (widgetLaunch) {
	createRoot(root).render(
		<StrictMode>
			<AppErrorBoundary appName="automations">
				<AutomationsI18nProvider>
					<AutomationsWidget launch={widgetLaunch} />
				</AutomationsI18nProvider>
			</AppErrorBoundary>
		</StrictMode>,
	);
} else {
	createRoot(root).render(
		<StrictMode>
			<AppErrorBoundary appName="automations">
				<AutomationsI18nProvider>
					<AutomationsApp />
				</AutomationsI18nProvider>
			</AppErrorBoundary>
		</StrictMode>,
	);
}
