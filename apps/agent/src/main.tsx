import "@brainstorm/sdk/app-theme.css";
import "@brainstorm/sdk/composer-context.css";
import "@brainstorm/sdk/empty-state.css";
import "@brainstorm/sdk/markdown.css";
import { AppErrorBoundary } from "@brainstorm/sdk/error-boundary";
import { mountMenuHost } from "@brainstorm/sdk/menus";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AgentApp } from "./app";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Agent: #root not found in index.html");
// Stand up the shared fancy-menus runtime (object / context menus).
mountMenuHost();
createRoot(root).render(
	<StrictMode>
		<AppErrorBoundary appName="agent">
			<AgentApp />
		</AppErrorBoundary>
	</StrictMode>,
);
