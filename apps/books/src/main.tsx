import "@brainstorm/sdk/app-theme.css";
import "@brainstorm/sdk/empty-state.css";
import "@brainstorm/editor/editor.css";
import { AppErrorBoundary } from "@brainstorm/sdk/error-boundary";
import { mountMenuHost } from "@brainstorm/sdk/menus";
import { getWidgetLaunch } from "@brainstorm/sdk/widget";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BooksApp } from "./app";
import "./styles.css";
import { BooksWidget } from "./widget";

const root = document.getElementById("root");
if (!root) throw new Error("books: #root not found in index.html");

document.body.classList.remove("is-booting");

// Stand up the fancy-menus runtime so the library sort menu + the header
// object ⋯ menu render through the shared themed surfaces.
mountMenuHost();

// Widget-mode: the dashboard launched this bundle as a widget. Mount the
// compact currently-reading glance list instead of the full Books app.
const widgetLaunch = getWidgetLaunch();
if (widgetLaunch) {
	createRoot(root).render(
		<StrictMode>
			<AppErrorBoundary appName="books">
				<BooksWidget launch={widgetLaunch} />
			</AppErrorBoundary>
		</StrictMode>,
	);
} else {
	createRoot(root).render(
		<StrictMode>
			<AppErrorBoundary appName="books">
				<BooksApp />
			</AppErrorBoundary>
		</StrictMode>,
	);
}
