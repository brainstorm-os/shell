import "@brainstorm/editor/editor-theme.css";
import { initAnalytics } from "@brainstorm/sdk/analytics";
import "@brainstorm/sdk/app-theme.css";
import "@brainstorm/sdk/composer-context.css";
import "@brainstorm/sdk/empty-state.css";
import { mountMenuHost } from "@brainstorm/sdk/menus";
import { getWidgetLaunch } from "@brainstorm/sdk/widget";
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
