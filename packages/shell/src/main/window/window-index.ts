/**
 * WindowIndex — the dashboard-facing view of every open app window per
 *  §The window index.
 *
 * Source of truth = `AppLauncher.windowsFor(...)`. The index attaches focus /
 * blur / title-update / minimize / move / resize / close listeners to each
 * tracked `BrowserWindow` so the live snapshot stays current without polling.
 *
 * Privileged surface: only the dashboard renderer reads it. Apps cannot
 * enumerate other apps' windows. Surfaced via `windows:*` IPC handlers
 * (registered in `ipc/windows-handlers.ts`), which the dashboard preload
 * exposes as `window.brainstorm.windows.*`.
 *
 * The index is decoupled from Electron via a `WindowController` interface so
 * the bulk of the logic can be unit-tested without spinning up a real
 * BrowserWindow.
 */

import {
	type MonitorSummary,
	type WindowBounds,
	type WindowEntry,
	WindowState,
} from "@brainstorm-os/protocol/window-types";
import type { AppLauncher } from "../apps/launcher";
import { type MonitorInfo, monitorIdFor } from "./monitor";
import { type TilePreset, projectOntoMonitor, tileBounds } from "./tile";

export { WindowState };
export type { MonitorSummary, WindowBounds, WindowEntry };

/** Minimal duck-typed BrowserWindow shape the index drives. */
export interface WindowController {
	readonly id: number;
	isDestroyed(): boolean;
	getTitle(): string;
	getBounds(): WindowBounds;
	isFocused(): boolean;
	isMinimized(): boolean;
	isMaximized(): boolean;
	isFullScreen(): boolean;
	focus(): void;
	show(): void;
	restore(): void;
	minimize(): void;
	close(): void;
	maximize(): void;
	unmaximize(): void;
	setBounds(bounds: WindowBounds): void;
	on(event: WindowEvent, listener: () => void): void;
	off(event: WindowEvent, listener: () => void): void;
}

export type WindowEvent =
	| "focus"
	| "blur"
	| "page-title-updated"
	| "minimize"
	| "restore"
	| "maximize"
	| "unmaximize"
	| "enter-full-screen"
	| "leave-full-screen"
	| "move"
	| "resize"
	| "closed";

/** Per-app metadata pulled from the installed-apps registry. */
export type AppMeta = { appId: string; appName: string };

export type WindowIndexOptions = {
	launcher: AppLauncher;
	getMonitors: () => readonly MonitorInfo[];
	/** Resolves app metadata (display name) at attach time. */
	resolveAppMeta: (appId: string) => AppMeta;
	/**
	 * Monotonic focus stamp source. Injected so app-window focus recency shares
	 * a single clock with the (non-indexed) dashboard window — dock-click
	 * activation compares the two to surface whichever was focused last. Falls
	 * back to a private counter when omitted (unit tests).
	 */
	nextFocusStamp?: () => number;
};

type ContainerView = ReturnType<AppLauncher["allContainers"]>[number];

type Tracked = {
	entry: WindowEntry;
	controller: WindowController;
	detach: () => void;
};

/** Trailing-coalesce window for the high-frequency move/resize notify so a
 *  live drag/resize fans out to the dashboard at most ~once per frame
 *  instead of once per Electron event (which on macOS Live Resize is many
 *  per frame). Discrete events (focus/blur/title/state) stay immediate. */
const NOTIFY_COALESCE_MS = 16;

export class WindowIndex {
	private readonly tracked = new Map<string, Tracked>();
	private readonly listeners = new Set<() => void>();
	private detachLauncher: (() => void) | null = null;
	private disposed = false;
	private focusCounter = 0;
	private readonly nextStamp: () => number;
	private notifyTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly options: WindowIndexOptions) {
		this.nextStamp = options.nextFocusStamp ?? (() => ++this.focusCounter);
		this.detachLauncher = this.options.launcher.onWindowsChanged(() => this.reconcile());
		this.reconcile();
	}

	list(): WindowEntry[] {
		return [...this.tracked.values()]
			.map((t) => ({ ...t.entry, bounds: { ...t.entry.bounds } }))
			.sort((a, b) => b.lastFocusedAt - a.lastFocusedAt);
	}

	get(id: string): WindowEntry | null {
		const tracked = this.tracked.get(id);
		return tracked ? { ...tracked.entry, bounds: { ...tracked.entry.bounds } } : null;
	}

	monitors(): MonitorSummary[] {
		return this.options.getMonitors().map((monitor, index) => ({
			id: monitorIdFor(monitor),
			label: monitor.primary ? "Primary" : `Display ${index + 1}`,
			primary: !!monitor.primary,
			bounds: { ...monitor.bounds },
			workArea: { ...monitor.workArea },
		}));
	}

	onChanged(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	focus(id: string): boolean {
		const tracked = this.tracked.get(id);
		if (!tracked || tracked.controller.isDestroyed()) return false;
		const { controller } = tracked;
		if (controller.isMinimized()) controller.restore();
		controller.show();
		controller.focus();
		return true;
	}

	minimize(id: string): boolean {
		const tracked = this.tracked.get(id);
		if (!tracked || tracked.controller.isDestroyed()) return false;
		tracked.controller.minimize();
		return true;
	}

	close(id: string): boolean {
		const tracked = this.tracked.get(id);
		if (!tracked || tracked.controller.isDestroyed()) return false;
		tracked.controller.close();
		return true;
	}

	tile(id: string, preset: TilePreset, monitorId?: string): boolean {
		const tracked = this.tracked.get(id);
		if (!tracked || tracked.controller.isDestroyed()) return false;
		const monitor = this.findMonitor(monitorId ?? tracked.entry.monitorId) ?? this.findPrimary();
		if (!monitor) return false;
		const bounds = tileBounds(preset, monitor);
		if (tracked.controller.isMaximized()) tracked.controller.unmaximize();
		if (tracked.controller.isMinimized()) tracked.controller.restore();
		tracked.controller.setBounds(bounds);
		return true;
	}

	moveToMonitor(id: string, monitorId: string): boolean {
		const tracked = this.tracked.get(id);
		if (!tracked || tracked.controller.isDestroyed()) return false;
		const monitors = this.options.getMonitors();
		const from = monitors.find((m) => monitorIdFor(m) === tracked.entry.monitorId);
		const to = monitors.find((m) => monitorIdFor(m) === monitorId);
		if (!to) return false;
		const sourceBounds = tracked.controller.getBounds();
		const sourceMonitor =
			from ?? monitors.find((m) => containsCenter(m, sourceBounds)) ?? monitors[0];
		if (!sourceMonitor) return false;
		if (tracked.controller.isMaximized()) tracked.controller.unmaximize();
		if (tracked.controller.isMinimized()) tracked.controller.restore();
		tracked.controller.setBounds(projectOntoMonitor(sourceBounds, sourceMonitor, to));
		return true;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.notifyTimer !== null) {
			clearTimeout(this.notifyTimer);
			this.notifyTimer = null;
		}
		this.detachLauncher?.();
		this.detachLauncher = null;
		for (const tracked of this.tracked.values()) tracked.detach();
		this.tracked.clear();
		this.listeners.clear();
	}

	// ── internal ───────────────────────────────────────────────────────────

	private reconcile(): void {
		const live = new Map<string, ContainerView>();
		for (const view of this.launcherContainers()) {
			live.set(keyFor(view.appId, view.windowId), view);
		}

		for (const id of [...this.tracked.keys()]) {
			if (!live.has(id)) {
				this.untrack(id);
			}
		}
		for (const [id, view] of live) {
			const tracked = this.tracked.get(id);
			if (!tracked) {
				this.trackOne(id, view);
			} else {
				// Active-tab title / route can change without a window-level event
				// (the change rides the launcher's change stream) — refresh them.
				tracked.entry.title = safeCall(() => tracked.controller.getTitle(), tracked.entry.appId);
				tracked.entry.route = view.container.activeRoute();
			}
		}
		this.notify();
	}

	private trackOne(id: string, view: ContainerView): void {
		const controller = view.container.baseWindow as unknown as WindowController;
		const [appId, windowId] = splitKey(id);
		const meta = this.options.resolveAppMeta(appId);
		const entry: WindowEntry = {
			id,
			appId,
			appName: meta.appName,
			windowId,
			title: safeCall(() => controller.getTitle(), appId),
			route: view.container.activeRoute(),
			monitorId: this.resolveMonitorId(safeCall(() => controller.getBounds(), null)),
			bounds: safeCall(() => controller.getBounds(), { x: 0, y: 0, width: 0, height: 0 }),
			state: this.stateOf(controller),
			focused: safeCall(() => controller.isFocused(), false),
			lastFocusedAt: 0,
		};
		if (entry.focused) entry.lastFocusedAt = this.nextStamp();

		const refresh = (updateFocusTimestamp = false, coalesce = false) => {
			if (controller.isDestroyed()) return;
			const bounds = controller.getBounds();
			entry.title = controller.getTitle();
			entry.bounds = bounds;
			entry.monitorId = this.resolveMonitorId(bounds);
			entry.state = this.stateOf(controller);
			const focusedNow = controller.isFocused();
			if (focusedNow && !entry.focused) {
				entry.lastFocusedAt = this.nextStamp();
			}
			entry.focused = focusedNow;
			if (updateFocusTimestamp && focusedNow) {
				entry.lastFocusedAt = this.nextStamp();
			}
			if (coalesce) this.scheduleNotify();
			else this.notify();
		};

		const onFocus = () => {
			entry.focused = true;
			entry.lastFocusedAt = this.nextStamp();
			// Other entries' `focused` flags are now stale — flip them.
			for (const [otherId, tracked] of this.tracked) {
				if (otherId !== id && tracked.entry.focused) {
					tracked.entry.focused = false;
				}
			}
			this.notify();
		};
		const onBlur = () => {
			entry.focused = false;
			this.notify();
		};
		const onState = () => refresh();
		const onMove = () => refresh(false, true);

		controller.on("focus", onFocus);
		controller.on("blur", onBlur);
		controller.on("minimize", onState);
		controller.on("restore", onState);
		controller.on("maximize", onState);
		controller.on("unmaximize", onState);
		controller.on("enter-full-screen", onState);
		controller.on("leave-full-screen", onState);
		controller.on("move", onMove);
		controller.on("resize", onMove);

		const detach = () => {
			try {
				controller.off("focus", onFocus);
				controller.off("blur", onBlur);
				controller.off("minimize", onState);
				controller.off("restore", onState);
				controller.off("maximize", onState);
				controller.off("unmaximize", onState);
				controller.off("enter-full-screen", onState);
				controller.off("leave-full-screen", onState);
				controller.off("move", onMove);
				controller.off("resize", onMove);
			} catch {
				// Window already torn down — listeners cleaned up by Electron.
			}
		};

		this.tracked.set(id, { entry, controller, detach });
	}

	private untrack(id: string): void {
		const tracked = this.tracked.get(id);
		if (!tracked) return;
		tracked.detach();
		this.tracked.delete(id);
	}

	/** Coalesce a pending notify into a single trailing flush. A subsequent
	 *  immediate `notify()` (discrete event) cancels it — it already sends
	 *  the latest in-place-mutated state, so the trailing flush is redundant. */
	private scheduleNotify(): void {
		if (this.disposed || this.notifyTimer !== null) return;
		this.notifyTimer = setTimeout(() => {
			this.notifyTimer = null;
			this.notify();
		}, NOTIFY_COALESCE_MS);
	}

	private notify(): void {
		if (this.disposed) return;
		if (this.notifyTimer !== null) {
			clearTimeout(this.notifyTimer);
			this.notifyTimer = null;
		}
		for (const listener of this.listeners) {
			try {
				listener();
			} catch (error) {
				console.warn("[WindowIndex] listener threw:", error);
			}
		}
	}

	private launcherContainers(): ContainerView[] {
		// A parked (warm-kept) container reads as closed — exclude it from the index.
		return this.options.launcher.allContainers().filter((view) => !view.parked);
	}

	private findMonitor(monitorId: string): MonitorInfo | null {
		for (const monitor of this.options.getMonitors()) {
			if (monitorIdFor(monitor) === monitorId) return monitor;
		}
		return null;
	}

	private findPrimary(): MonitorInfo | null {
		const monitors = this.options.getMonitors();
		return monitors.find((m) => m.primary) ?? monitors[0] ?? null;
	}

	private resolveMonitorId(bounds: WindowBounds | null): string {
		const monitors = this.options.getMonitors();
		if (!bounds || monitors.length === 0) return monitors[0] ? monitorIdFor(monitors[0]) : "";
		const containing = monitors.find((m) => containsCenter(m, bounds));
		return monitorIdFor(containing ?? monitors[0] ?? ({} as MonitorInfo));
	}

	private stateOf(controller: WindowController): WindowState {
		if (controller.isDestroyed()) return WindowState.Normal;
		if (controller.isMinimized()) return WindowState.Minimized;
		if (controller.isFullScreen()) return WindowState.Fullscreen;
		if (controller.isMaximized()) return WindowState.Maximized;
		return WindowState.Normal;
	}
}

function safeCall<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

function containsCenter(monitor: MonitorInfo, bounds: WindowBounds): boolean {
	const a = monitor.workArea;
	const cx = bounds.x + Math.floor(bounds.width / 2);
	const cy = bounds.y + Math.floor(bounds.height / 2);
	return cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height;
}

function keyFor(appId: string, windowId: string): string {
	return `${appId}::${windowId}`;
}

function splitKey(id: string): [string, string] {
	const idx = id.indexOf("::");
	if (idx < 0) return [id, "main"];
	return [id.slice(0, idx), id.slice(idx + 2)];
}
