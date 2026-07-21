import "@brainstorm-os/sdk/app-theme.css";
import "@brainstorm-os/sdk/segmented.css";
import { initAnalytics } from "@brainstorm-os/sdk/analytics";
import "@brainstorm-os/sdk/property-ui/cells.css";
import "@brainstorm-os/sdk/select-menu.css";
import { AppErrorBoundary } from "@brainstorm-os/sdk/error-boundary";
import { mountMenuHost } from "@brainstorm-os/sdk/menus";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FormDesignerApp } from "./app";
import { FormDesignerI18nProvider } from "./i18n-provider";
import "./styles.css";

initAnalytics();

const root = document.getElementById("root");
if (!root) throw new Error("form-designer: #root not found in index.html");

document.body.classList.remove("is-booting");

// Stand up the fancy-menus runtime so the target-type select, the
// add-field property picker, the object ⋯ menu, and the fill-mode
// property cells (Tag / Link / Date editors) resolve the published menu
// store and render themed surfaces.
mountMenuHost();

createRoot(root).render(
	<StrictMode>
		<AppErrorBoundary appName="form-designer">
			<FormDesignerI18nProvider>
				<FormDesignerApp />
			</FormDesignerI18nProvider>
		</AppErrorBoundary>
	</StrictMode>,
);
