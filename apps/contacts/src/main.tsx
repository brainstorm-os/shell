import "@brainstorm/sdk/app-theme.css";
import "@brainstorm/sdk/empty-state.css";
import "@brainstorm/editor/editor.css";
import "@brainstorm/editor/editor-theme.css";
import { AppErrorBoundary } from "@brainstorm/sdk/error-boundary";
import { mountMenuHost } from "@brainstorm/sdk/menus";
import { getWidgetLaunch } from "@brainstorm/sdk/widget";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ContactsApp } from "./app";
import "./styles.css";
import { ContactsWidget } from "./widget";

// One shared fancy-menus host per app — every menu (object ⋯, anchored
// overflow, row right-click) renders through it.
mountMenuHost();

const root = document.getElementById("root");
if (!root) throw new Error("Contacts: #root not found in index.html");

// Widget-mode (Stage 7.3 / 9.12.13(c)): the dashboard launched this bundle as a
// widget. Mount the compact glance list instead of the full Contacts app.
const widgetLaunch = getWidgetLaunch();
if (widgetLaunch) {
	createRoot(root).render(
		<StrictMode>
			<AppErrorBoundary appName="contacts">
				<ContactsWidget launch={widgetLaunch} />
			</AppErrorBoundary>
		</StrictMode>,
	);
} else {
	createRoot(root).render(
		<StrictMode>
			<AppErrorBoundary appName="contacts">
				<ContactsApp />
			</AppErrorBoundary>
		</StrictMode>,
	);
}
