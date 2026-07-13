import "@brainstorm/sdk/app-theme.css";
import { initAnalytics } from "@brainstorm/sdk/analytics";
import "@brainstorm/editor/editor.css";
import { AppErrorBoundary } from "@brainstorm/sdk/error-boundary";
import { applyPersistedPanelWidth } from "@brainstorm/sdk/resizable";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GraphApp } from "./app";
import "./styles.css";

// Restore the sidebar width onto the body CSS var synchronously, before the
// first paint, so the sidebar opens at its persisted width (not the 320px
// default flashing to the stored value).
applyPersistedPanelWidth({
	storageKey: "graph:sidebar-width",
	cssVar: "--graph-sidebar-width",
	defaultWidth: 320,
});

initAnalytics();

const root = document.getElementById("root");
if (!root) throw new Error("graph: #root not found in index.html");
createRoot(root).render(
	<StrictMode>
		<AppErrorBoundary appName="graph">
			<GraphApp />
		</AppErrorBoundary>
	</StrictMode>,
);
