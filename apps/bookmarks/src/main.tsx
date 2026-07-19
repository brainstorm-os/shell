/**
 * Bookmarks entry — mounts the React app into `#root`. Stands up the shared
 * fancy-menus runtime (object / context menus), pre-applies the persisted
 * sidebar width before first paint, and wires the shared editor's media upload
 * (drag-drop / paste / `/image` in the bookmark detail's notes) through the
 * storage service.
 */

import "@brainstorm/sdk/app-theme.css";
import "@brainstorm/sdk/empty-state.css";
import { setEditorHost } from "@brainstorm/editor";
import { initAnalytics } from "@brainstorm/sdk/analytics";
import { AppErrorBoundary } from "@brainstorm/sdk/error-boundary";
import { mountMenuHost } from "@brainstorm/sdk/menus";
import { applyPersistedPanelWidth } from "@brainstorm/sdk/resizable";
import { getWidgetLaunch } from "@brainstorm/sdk/widget";
import { createRoot } from "react-dom/client";
import { BookmarksApp } from "./app";
import { getBrainstorm } from "./storage/runtime";
import { mountBookmarksWidget } from "./widget";
import "./styles.css";

initAnalytics();

// Widget-mode (Stage 7.3): the dashboard launched this bundle as a widget.
// Mount the compact React widget surface (recent-bookmarks glance) instead of
// the full app, and skip the full-app bootstrap below.
const widgetLaunch = getWidgetLaunch();
if (widgetLaunch) {
	const widgetRoot = document.getElementById("root");
	if (widgetRoot) mountBookmarksWidget(widgetRoot, widgetLaunch);
} else {
	bootstrapBookmarksApp();
}

function bootstrapBookmarksApp(): void {
	// Set the persisted sidebar width before any DOM work, to avoid a flash where
	// the first paint uses the CSS-default width and then `.bookmarks`'s
	// grid-template-columns transition animates to the persisted value.
	applyPersistedPanelWidth({
		storageKey: "bookmarks:sidebar-width",
		cssVar: "--bookmarks-sidebar-width",
		defaultWidth: 248,
	});

	// Stand up the fancy-menus runtime so object / context menus open through the
	// shared bridge (Stage 8.8).
	mountMenuHost();

	// Wire the shared editor's media upload through the storage service. Degrades
	// to an inline data URL when absent (preview / older shell).
	const storageSvc = getBrainstorm()?.services?.storage;
	if (storageSvc) {
		setEditorHost({
			uploadFile: (filename, bytes, mime) => storageSvc.uploadFile(filename, bytes, mime),
		});
	}

	const root = document.getElementById("root");
	if (!root) throw new Error("bookmarks: #root missing");

	createRoot(root).render(
		<AppErrorBoundary appName="bookmarks">
			<BookmarksApp />
		</AppErrorBoundary>,
	);
}
