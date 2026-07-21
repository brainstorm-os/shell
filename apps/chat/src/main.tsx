import "@brainstorm-os/editor/editor-theme.css";
import { initAnalytics } from "@brainstorm-os/sdk/analytics";
import "@brainstorm-os/sdk/app-theme.css";
import "@brainstorm-os/sdk/composer-context.css";
import "@brainstorm-os/sdk/empty-state.css";
import { mountMenuHost } from "@brainstorm-os/sdk/menus";
import { getWidgetLaunch } from "@brainstorm-os/sdk/widget";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChatApp } from "./app";
import { ChatI18nProvider } from "./i18n-provider";
import "./styles.css";
import { ChatWidget } from "./widget";

initAnalytics();

const root = document.getElementById("root");
if (!root) throw new Error("Chat: #root not found in index.html");
// Stand up the shared fancy-menus runtime (object / context menus).
mountMenuHost();

// Widget-mode: the dashboard launched this bundle as a widget. Mount the
// compact recent-messages glance list instead of the full Chat app.
const widgetLaunch = getWidgetLaunch();
createRoot(root).render(
	<StrictMode>
		<ChatI18nProvider>
			{widgetLaunch ? <ChatWidget launch={widgetLaunch} /> : <ChatApp />}
		</ChatI18nProvider>
	</StrictMode>,
);
