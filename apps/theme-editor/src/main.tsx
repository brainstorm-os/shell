import "@brainstorm/sdk/app-theme.css";
import "@brainstorm/sdk/color-picker.css";
import { AppErrorBoundary } from "@brainstorm/sdk/error-boundary";
import { mountMenuHost } from "@brainstorm/sdk/menus";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeEditorApp } from "./app";
import { ThemeEditorI18nProvider } from "./i18n-provider";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("theme-editor: #root not found in index.html");

document.body.classList.remove("is-booting");

// Stand up the fancy-menus runtime so the theme-select / scale / overflow
// menus + the token-grid colour picker resolve the published store and
// render themed surfaces (Stage 8.8 menu bridge).
mountMenuHost();

createRoot(root).render(
	<StrictMode>
		<AppErrorBoundary appName="theme-editor">
			<ThemeEditorI18nProvider>
				<ThemeEditorApp />
			</ThemeEditorI18nProvider>
		</AppErrorBoundary>
	</StrictMode>,
);
