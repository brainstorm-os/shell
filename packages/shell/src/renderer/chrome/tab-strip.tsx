import { DEFAULT_THEME, flattenTokens, isThemeName, themes } from "@brainstorm/tokens";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ChromeBridge, ChromeTab, ChromeTabsState } from "../../shared/chrome-tabs";
import "./tab-strip.css";

declare global {
	interface Window {
		brainstormChrome: ChromeBridge;
	}
}

/** Apply the active theme's tokens to `:root` (the preload only forwards the
 *  theme name — see the no-heavy-imports rule in chrome-preload.ts). */
function applyTheme(name: string | null): void {
	const resolved = isThemeName(name) ? name : DEFAULT_THEME;
	const root = document.documentElement;
	for (const [key, value] of Object.entries(flattenTokens(themes[resolved]))) {
		if (key.startsWith("--") && /^[a-zA-Z0-9_-]+$/.test(key.slice(2))) {
			root.style.setProperty(key, value);
		}
	}
}

function TabStrip() {
	const [tabs, setTabs] = useState<ChromeTab[]>([]);
	const dragId = useRef<string | null>(null);

	useEffect(() => {
		const off = window.brainstormChrome.onState((state: ChromeTabsState) => setTabs(state.tabs));
		// Pull the current state now that we're subscribed — the main-side push
		// may have fired before this effect ran.
		window.brainstormChrome.requestState();
		return off;
	}, []);

	const onDrop = (targetId: string) => {
		const from = dragId.current;
		dragId.current = null;
		if (!from || from === targetId) return;
		const order = tabs.map((t) => t.tabId);
		const next = order.filter((id) => id !== from);
		const at = next.indexOf(targetId);
		next.splice(at < 0 ? next.length : at, 0, from);
		window.brainstormChrome.reorderTabs(next);
	};

	// The strip is only mounted visible with 2+ tabs (a lone tab is just the
	// window — the shell collapses the strip to zero height), so every tab the
	// strip ever shows is one of several siblings: always closeable + reorderable.
	return (
		<div className="strip" role="tablist" aria-label="Open tabs">
			<div className="strip__tabs">
				{tabs.map((tab) => (
					<div
						key={tab.tabId}
						role="tab"
						aria-selected={tab.active}
						tabIndex={0}
						className={`tab${tab.active ? " tab--active" : ""}`}
						title={tab.title}
						draggable
						onDragStart={() => {
							dragId.current = tab.tabId;
						}}
						onDragOver={(e) => e.preventDefault()}
						onDrop={() => onDrop(tab.tabId)}
						onClick={() => window.brainstormChrome.activateTab(tab.tabId)}
						// keyboard-exempt: standard activation of this `role="tab"` — Enter/Space
						// activate the focused tab (the keyboard twin of the click), not an app shortcut.
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								window.brainstormChrome.activateTab(tab.tabId);
							}
						}}
						onAuxClick={(e) => {
							if (e.button === 1) window.brainstormChrome.closeTab(tab.tabId);
						}}
					>
						{tab.icon ? (
							<img
								key={tab.icon}
								className="tab__icon"
								src={tab.icon}
								alt=""
								draggable={false}
								onError={(e) => {
									e.currentTarget.style.display = "none";
								}}
							/>
						) : null}
						<span className="tab__title">{tab.title}</span>
						<button
							type="button"
							className="tab__close"
							aria-label="Close tab"
							onClick={(e) => {
								e.stopPropagation();
								window.brainstormChrome.closeTab(tab.tabId);
							}}
						>
							×
						</button>
					</div>
				))}
			</div>
			<button
				type="button"
				className="strip__new"
				aria-label="New tab"
				onClick={() => window.brainstormChrome.newTab()}
			>
				+
			</button>
		</div>
	);
}

applyTheme(window.brainstormChrome.initialTheme);
window.brainstormChrome.onTheme(applyTheme);

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<StrictMode>
			<TabStrip />
		</StrictMode>,
	);
}
