import "@brainstorm/sdk/app-theme.css";
import "@brainstorm/sdk/empty-state.css";
import "@brainstorm/editor/editor.css";
import { AppErrorBoundary } from "@brainstorm/sdk/error-boundary";
import { mountMenuHost } from "@brainstorm/sdk/menus";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PreviewApp } from "./app";
import { PreviewI18nProvider } from "./i18n-provider";
import { registerBuiltInPreviewModules } from "./logic/registry";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("preview: #root not found in index.html");

document.body.classList.remove("is-booting");

// Stand up the fancy-menus runtime so the object ⋯ menu opens through the
// shared bridge (Stage 8.8).
mountMenuHost();

// Per-kind renderer loaders (image / markdown / text / video / audio / code /
// pdf) register their lazy `import()` entries; the bundles stay off the
// cold-start path until the host actually mounts one.
registerBuiltInPreviewModules();

createRoot(root).render(
	<StrictMode>
		<AppErrorBoundary appName="preview">
			<PreviewI18nProvider>
				<PreviewApp />
			</PreviewI18nProvider>
		</AppErrorBoundary>
	</StrictMode>,
);
