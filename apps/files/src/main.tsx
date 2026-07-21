import "@brainstorm-os/sdk/app-theme.css";
import { initAnalytics } from "@brainstorm-os/sdk/analytics";
import "@brainstorm-os/editor/editor.css";
import { AppErrorBoundary } from "@brainstorm-os/sdk/error-boundary";
import { mountMenuHost } from "@brainstorm-os/sdk/menus";
import { applyPersistedPanelWidth } from "@brainstorm-os/sdk/resizable";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FilesApp } from "./app";
import { FilesI18nProvider } from "./i18n-provider";
import "./styles.css";

// Apply persisted panel widths BEFORE React renders, so the first paint
// already matches the post-mount width. See applyPersistedPanelWidth's
// own docs for the flash-of-default-width that happens without this.
applyPersistedPanelWidth({
	storageKey: "files:sidebar-width",
	cssVar: "--files-sidebar-width",
	defaultWidth: 248,
});
applyPersistedPanelWidth({
	storageKey: "files:inspector-width",
	cssVar: "--files-inspector-width",
	defaultWidth: 320,
});

initAnalytics();

const root = document.getElementById("root");
if (!root) throw new Error("Files: #root not found in index.html");
// Stand up the fancy-menus runtime so object / context menus open through
// the shared bridge (Stage 8.8).
mountMenuHost();
createRoot(root).render(
	<StrictMode>
		<AppErrorBoundary appName="files">
			<FilesI18nProvider>
				<FilesApp />
			</FilesI18nProvider>
		</AppErrorBoundary>
	</StrictMode>,
);
