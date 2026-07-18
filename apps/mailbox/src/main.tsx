import "@brainstorm/sdk/app-theme.css";
import "@brainstorm/sdk/segmented.css";
import { initAnalytics } from "@brainstorm/sdk/analytics";
import "@brainstorm/sdk/count-badge.css";
import "@brainstorm/sdk/empty-state.css";
import { AppErrorBoundary } from "@brainstorm/sdk/error-boundary";
import { mountMenuHost } from "@brainstorm/sdk/menus";
import { getWidgetLaunch } from "@brainstorm/sdk/widget";
import { createRoot } from "react-dom/client";
import { MailboxApp } from "./app";
import { MailboxI18nProvider } from "./i18n-provider";
import "./styles.css";
import { MailboxWidget } from "./widget";

// One shared fancy-menus host per app — the header ⋯ and composer menus open
// through openAnchoredMenu, which is a no-op without a mounted host.
mountMenuHost();

initAnalytics();

const root = document.getElementById("root");
if (!root) throw new Error("Mailbox: #root not found in index.html");
// No <StrictMode>: dev double-mount re-binds @lexical/yjs editors to an
// already-applied doc and blanks them (see project memory). Mailbox has no
// editor today, but the convention is followed for consistency.

// Widget-mode: the dashboard launched this bundle as a widget. Mount the
// compact inbox glance list instead of the full Mailbox app.
const widgetLaunch = getWidgetLaunch();
if (widgetLaunch) {
	createRoot(root).render(
		<AppErrorBoundary appName="mailbox">
			<MailboxI18nProvider>
				<MailboxWidget launch={widgetLaunch} />
			</MailboxI18nProvider>
		</AppErrorBoundary>,
	);
} else {
	createRoot(root).render(
		<AppErrorBoundary appName="mailbox">
			<MailboxI18nProvider>
				<MailboxApp />
			</MailboxI18nProvider>
		</AppErrorBoundary>,
	);
}
