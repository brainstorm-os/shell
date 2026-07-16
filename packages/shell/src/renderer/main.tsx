import { BrainstormMenuProvider } from "@brainstorm/sdk/menus";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles.css";
// fancy-menus chrome: the package runtime sheet first, then the SDK bridge
// that maps --fm-* onto Brainstorm tokens (bridge must win the cascade, so
// it imports second). See `@brainstorm/sdk/menus.css`.
import "@react-fancy-menus/core/runtime.css";
import "@brainstorm/sdk/menus.css";
// `<Searchbar>` (used in Marketplace + Settings → Data) renders `.bs-searchbar`
// classes whose chrome lives in the SDK. Apps pull it via `app-theme.css`; the
// shell renderer is sandbox-free and never loads that file, so import the
// searchbar-only sub-sheet directly.
import "@brainstorm/sdk/searchbar/searchbar.css";
// `<Checkbox>` chrome is shared with the apps (one definition in the SDK); same
// reason as the searchbar sheet above — the shell doesn't load `app-theme.css`,
// so import the checkbox sub-sheet directly.
import "@brainstorm/sdk/checkbox/checkbox.css";
import { DEFAULT_THEME } from "@brainstorm/tokens";
import { LocaleGate } from "./i18n/locale-gate";
import { ThemeProvider, applyThemeVars } from "./theme/theme-provider";
import { ErrorBoundary } from "./ui/error-boundary";
import "./ui/error-boundary.css";
import { initAnalytics } from "@brainstorm/sdk/analytics";
import { AnalyticsBetaNotice } from "./analytics/beta-notice";
import { ShellTracking } from "./analytics/shell-tracking";
import { installFocusNav } from "./focus-nav";
import { installErrorBridge } from "./ui/error-bridge";
import { installUpdateToastBridge } from "./update/update-toast-bridge";
import { VaultProvider } from "./vault-context";

initAnalytics();

installErrorBridge();
// Surfaces background-check update finds as actionable toasts (13.12).
installUpdateToastBridge();
// Keyboard-nav mode: focus rings only after a deliberate plain Tab (gated in
// styles.css on `html[data-kbnav]`). See focus-nav.ts.
installFocusNav();

// Static base so `:root` always carries CSS variables — the error-boundary
// fallback renders outside `<ThemeProvider>` (which now lives inside
// `<VaultProvider>` so it can pin the welcome theme on vault state). The live
// theme overwrites the same keys in place once the provider mounts.
applyThemeVars(DEFAULT_THEME);

// Stamp the OS on the document root so the global themed-scrollbar rules (which
// only restyle Windows/Linux, leaving macOS's native overlay scrollbars alone)
// reach every scroll container — including menus/popovers portaled to <body>.
document.documentElement.dataset.platform = window.brainstorm.platform;

const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Root element not found");
}

createRoot(rootElement).render(
	<StrictMode>
		<ErrorBoundary>
			<VaultProvider>
				<ThemeProvider>
					{/* Menu provider sits inside ThemeProvider so the `--fm-*`
					 *  bridge resolves against the live theme tokens. */}
					<BrainstormMenuProvider>
						<LocaleGate>
							<AnalyticsBetaNotice />
							<ShellTracking />
							<App />
						</LocaleGate>
					</BrainstormMenuProvider>
				</ThemeProvider>
			</VaultProvider>
		</ErrorBoundary>
	</StrictMode>,
);
