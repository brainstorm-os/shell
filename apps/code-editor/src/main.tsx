import "@brainstorm/sdk/app-theme.css";
import "@brainstorm/sdk/empty-state.css";
import { AppErrorBoundary } from "@brainstorm/sdk/error-boundary";
import { mountMenuHost } from "@brainstorm/sdk/menus";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CodeEditorApp } from "./app";
import { CodeEditorI18nProvider } from "./i18n-provider";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("code-editor: #root not found in index.html");

document.body.classList.remove("is-booting");

// Stand up the fancy-menus runtime so the object / context menus + the
// quick-open / command palettes open through the shared bridge (Stage 8.8).
mountMenuHost();

createRoot(root).render(
	<StrictMode>
		<AppErrorBoundary appName="code-editor">
			<CodeEditorI18nProvider>
				<CodeEditorApp />
			</CodeEditorI18nProvider>
		</AppErrorBoundary>
	</StrictMode>,
);
