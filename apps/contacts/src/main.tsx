import "@brainstorm-os/sdk/app-theme.css";
import { initAnalytics } from "@brainstorm-os/sdk/analytics";
import "@brainstorm-os/sdk/empty-state.css";
import "@brainstorm-os/editor/editor.css";
import "@brainstorm-os/editor/editor-theme.css";
import { AppErrorBoundary } from "@brainstorm-os/sdk/error-boundary";
import { mountMenuHost } from "@brainstorm-os/sdk/menus";
import { getWidgetLaunch } from "@brainstorm-os/sdk/widget";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ContactsApp } from "./app";
import { ContactsI18nProvider } from "./i18n-provider";
import "./styles.css";
import { ContactsWidget } from "./widget";

// One shared fancy-menus host per app — every menu (object ⋯, anchored
// overflow, row right-click) renders through it.
mountMenuHost();

initAnalytics();

const root = document.getElementById("root");
if (!root) throw new Error("Contacts: #root not found in index.html");

// Widget-mode (Stage 7.3 / 9.12.13(c)): the dashboard launched this bundle as a
// widget. Mount the compact glance list instead of the full Contacts app.
const widgetLaunch = getWidgetLaunch();
if (widgetLaunch) {
	createRoot(root).render(
		<StrictMode>
			<AppErrorBoundary appName="contacts">
				<ContactsI18nProvider>
					<ContactsWidget launch={widgetLaunch} />
				</ContactsI18nProvider>
			</AppErrorBoundary>
		</StrictMode>,
	);
} else {
	// The full app is intentionally NOT wrapped in <StrictMode>: the contact
	// page hosts a `@lexical/yjs` body editor, and StrictMode's dev
	// double-mount re-binds the editor to an already-applied Y.Doc whose
	// `observeDeep` then fires no events — the body renders blank on reopen.
	// Production is unaffected (StrictMode is a no-op there); dropping it
	// makes dev match the shipped app. Same fix + rationale as
	// `apps/notes/src/main.tsx` / Tasks' inspector-editor mount. The widget
	// branch above keeps StrictMode — it mounts no editor.
	createRoot(root).render(
		<AppErrorBoundary appName="contacts">
			<ContactsI18nProvider>
				<ContactsApp />
			</ContactsI18nProvider>
		</AppErrorBoundary>,
	);
}
