import {
	type ChromeBridge,
	type ChromeSplitState,
	type ChromeTab,
	type ChromeTabsState,
	SplitStep,
} from "@brainstorm-os/protocol/chrome-tabs";
import { DEFAULT_THEME, flattenTokens, isThemeName, themes } from "@brainstorm-os/tokens";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
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

/** The split divider (6.14). The chrome view lies under both app panes while
 *  the window is split; this element sits in the gap between them, the only
 *  part of the chrome the user can see there. Main owns the geometry: a drag
 *  sends the pointer x, a key sends a step, and the next state push moves it. */
function SplitDivider({ split }: { split: ChromeSplitState }) {
	const dragging = useRef(false);
	const pendingX = useRef<number | null>(null);
	const frame = useRef<number | null>(null);

	useEffect(
		() => () => {
			if (frame.current !== null) cancelAnimationFrame(frame.current);
		},
		[],
	);

	// One IPC per frame however fast the pointer moves.
	const queueDrag = (x: number) => {
		pendingX.current = x;
		if (frame.current !== null) return;
		frame.current = requestAnimationFrame(() => {
			frame.current = null;
			if (pendingX.current !== null) window.brainstormChrome.dragSplit(pendingX.current);
			pendingX.current = null;
		});
	};

	const { divider, leftRatio } = split;
	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize panes"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(leftRatio * 100)}
			tabIndex={0}
			className="split-divider"
			style={{ left: divider.x, top: divider.y, width: divider.width, height: divider.height }}
			onPointerDown={(e) => {
				dragging.current = true;
				e.currentTarget.setPointerCapture(e.pointerId);
			}}
			onPointerMove={(e) => {
				if (dragging.current) queueDrag(e.clientX);
			}}
			onPointerUp={(e) => {
				dragging.current = false;
				e.currentTarget.releasePointerCapture(e.pointerId);
			}}
			onPointerCancel={() => {
				dragging.current = false;
			}}
			// keyboard-exempt: the WAI-ARIA window-splitter pattern — Left/Right move
			// a focused separator. The registry chords (shell/split.divider-*) are the
			// app-wide path; this is the focused-control twin.
			onKeyDown={(e) => {
				if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
					e.preventDefault();
					window.brainstormChrome.stepSplit(e.key === "ArrowLeft" ? SplitStep.Left : SplitStep.Right);
				}
			}}
		/>
	);
}

function TabStrip() {
	const [tabs, setTabs] = useState<ChromeTab[]>([]);
	const [split, setSplit] = useState<ChromeSplitState | null>(null);
	const dragId = useRef<string | null>(null);

	useEffect(() => {
		const off = window.brainstormChrome.onState((state: ChromeTabsState) => {
			setTabs(state.tabs);
			setSplit(state.split ?? null);
		});
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
	// Split: the chrome spans the whole window, so the strip pins to its own
	// height (or leaves entirely when collapsed) instead of filling the view —
	// a full-height strip would make the divider gap an OS window-drag region.
	const stripStyle = split ? { height: split.stripHeight } : undefined;
	const showStrip = !split || split.stripHeight > 0;
	return (
		<>
			{showStrip ? <Strip tabs={tabs} style={stripStyle} onDrop={onDrop} dragId={dragId} /> : null}
			{split ? <SplitDivider split={split} /> : null}
		</>
	);
}

function Strip({
	tabs,
	style,
	onDrop,
	dragId,
}: {
	tabs: ChromeTab[];
	style: { height: number } | undefined;
	onDrop: (targetId: string) => void;
	dragId: { current: string | null };
}) {
	return (
		<div className="strip" role="tablist" aria-label="Open tabs" style={style}>
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
