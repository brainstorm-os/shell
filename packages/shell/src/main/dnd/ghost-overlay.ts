/**
 * The shell-owned cursor-following drag ghost (DND-2b,
 * §Part IV.2; OQ-DND-1 → option (a): a transparent click-through always-on-top
 * `BrowserWindow`). It is shell-owned precisely *because* it must paint OVER
 * other apps' windows as the cursor crosses them — an app renderer can only
 * paint inside its own bounds. The window is frameless, transparent, ignores
 * mouse events (so the live drag's pointer passes through to the windows
 * underneath), never takes focus (the source app keeps pointer capture + the
 * Esc-to-cancel key), and floats above every app + fullscreen surface.
 *
 * Reference-only by construction (Principle 1): the ghost renders the
 * `DragGhostSpec` — a label, an optional glyph, an N-badge — never the payload.
 *
 * The overlay logic (lazy create, cursor-offset positioning, last-spec re-render
 * on effect change) is pure over an injected `GhostWindow`, so it is unit-tested
 * without a real `BrowserWindow`; `createElectronGhostWindow` is the thin
 * Electron binding wired in `main/index.ts`.
 */

import { type DragGhostSpec, type DragPoint, DropEffect } from "@brainstorm-os/sdk-types";
import { BrowserWindow } from "electron";
import type { GhostOverlay } from "./dnd-service";

/** Offset (screen px) of the ghost's top-left from the cursor hot-spot, so the
 *  chip trails the pointer instead of sitting under it (and under the OS cursor
 *  the live drag still shows). */
export const GHOST_CURSOR_OFFSET: DragPoint = { x: 14, y: 16 };

/** Window box (DIP). Transparent + click-through, so the empty area is invisible
 *  and inert; the chip anchors to the top-left and auto-sizes within. */
export const GHOST_WINDOW_SIZE = { width: 360, height: 132 } as const;

/** Position the ghost window's top-left from a screen-space cursor point. */
export function ghostScreenPosition(point: DragPoint): DragPoint {
	return {
		x: Math.round(point.x + GHOST_CURSOR_OFFSET.x),
		y: Math.round(point.y + GHOST_CURSOR_OFFSET.y),
	};
}

/** The minimal window surface the overlay drives. Injected so the lazy-create /
 *  positioning / re-render logic is testable without Electron. */
export type GhostWindow = {
	isDestroyed(): boolean;
	setPosition(x: number, y: number): void;
	/** Push the full chip state (label/glyph/count + the current drop effect). */
	render(spec: DragGhostSpec, effect: DropEffect): void;
	/** Make visible WITHOUT taking focus (the source keeps pointer capture). */
	showInactive(): void;
	hide(): void;
};

/**
 * Build the `GhostOverlay` the `dnd` service drives, lazily creating its window
 * on the first `show` (no window exists until a drag begins). `createWindow` is
 * injected — production passes `createElectronGhostWindow`, tests a fake.
 */
export function createGhostOverlay(createWindow: () => GhostWindow): GhostOverlay {
	let win: GhostWindow | null = null;
	let lastSpec: DragGhostSpec | null = null;
	let effect: DropEffect = DropEffect.None;

	const ensure = (): GhostWindow => {
		if (!win || win.isDestroyed()) win = createWindow();
		return win;
	};
	const live = (): GhostWindow | null => (win && !win.isDestroyed() ? win : null);

	return {
		show(spec: DragGhostSpec, at: DragPoint): void {
			lastSpec = spec;
			effect = DropEffect.None; // a fresh drag starts with no accepting target
			const w = ensure();
			const pos = ghostScreenPosition(at);
			w.setPosition(pos.x, pos.y);
			w.render(spec, effect);
			w.showInactive();
		},
		move(to: DragPoint): void {
			const w = live();
			if (!w) return;
			const pos = ghostScreenPosition(to);
			w.setPosition(pos.x, pos.y);
		},
		setEffect(next: DropEffect): void {
			effect = next;
			const w = live();
			if (!w || !lastSpec) return;
			w.render(lastSpec, effect);
		},
		hide(): void {
			live()?.hide();
		},
	};
}

/** The drop-effect glyph the chip shows as its cursor affordance. */
function effectGlyph(effect: DropEffect): string {
	switch (effect) {
		case DropEffect.Copy:
			return "+";
		case DropEffect.Link:
			return "🔗";
		case DropEffect.Move:
			return "→";
		default:
			return "⊘";
	}
}

/** Inline page for the ghost window. Self-contained (no preload, no bundling) —
 *  main pushes state via `executeJavaScript(window.__ghost(...))`. Neutral dark
 *  translucent chip so the label reads on ANY underlying app/theme. Reduce-motion
 *  is honoured in CSS — the fade-in only runs under `no-preference`; the cursor
 *  follow itself is inertia-free (direct `setPosition`). */
const GHOST_PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root{color-scheme:dark}
  html,body{margin:0;padding:0;background:transparent;overflow:hidden;
    font:13px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    -webkit-user-select:none;user-select:none;cursor:default}
  #chip{position:absolute;top:6px;left:6px;max-width:340px;display:inline-flex;
    align-items:center;gap:8px;padding:7px 11px;border-radius:10px;
    background:rgba(20,24,33,.92);color:#f3f6fb;
    border:1px solid rgba(255,255,255,.14);
    box-shadow:0 8px 24px rgba(0,0,0,.42);box-sizing:border-box;opacity:0}
  #chip.shown{opacity:1}
  @media (prefers-reduced-motion:no-preference){#chip{transition:opacity .09s ease}}
  #chip.nodrop{opacity:.62}
  #glyph{flex:0 0 auto;font-size:15px;line-height:1}
  #label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;
    white-space:nowrap;font-weight:500}
  #badge{flex:0 0 auto;min-width:18px;height:18px;padding:0 5px;border-radius:9px;
    background:rgba(255,255,255,.18);color:#fff;font-size:11px;font-weight:600;
    display:none;align-items:center;justify-content:center}
  #effect{flex:0 0 auto;width:18px;height:18px;border-radius:9px;
    background:rgba(255,255,255,.14);display:flex;align-items:center;
    justify-content:center;font-size:12px;line-height:1}
</style></head><body>
  <div id="chip"><span id="glyph"></span><span id="label"></span>
    <span id="badge"></span><span id="effect"></span></div>
  <script>
    window.__ghost = function(s){
      var chip=document.getElementById('chip');
      document.getElementById('label').textContent=s.label||'';
      var g=document.getElementById('glyph');
      g.textContent=s.iconRef||''; g.style.display=s.iconRef?'inline':'none';
      var b=document.getElementById('badge');
      if(s.count>1){b.textContent=String(s.count);b.style.display='inline-flex';}
      else{b.style.display='none';}
      document.getElementById('effect').textContent=s.effect||'';
      chip.classList.toggle('nodrop', s.nodrop===true);
      chip.classList.add('shown');
    };
  </script></body></html>`;

const GHOST_PAGE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(GHOST_PAGE_HTML)}`;

/**
 * The Electron binding: a transparent, frameless, click-through, focus-less,
 * always-on-top window that floats over every app + fullscreen space. Renders
 * via main-initiated `executeJavaScript` (no preload / IPC surface). Pushes that
 * land before the page finishes loading are coalesced to the latest and flushed
 * on `did-finish-load`, so the very first `render` (issued inside the same tick
 * as window creation) isn't dropped.
 */
export function createElectronGhostWindow(): GhostWindow {
	const window = new BrowserWindow({
		width: GHOST_WINDOW_SIZE.width,
		height: GHOST_WINDOW_SIZE.height,
		show: false,
		frame: false,
		transparent: true,
		resizable: false,
		movable: false,
		minimizable: false,
		maximizable: false,
		closable: false,
		focusable: false,
		skipTaskbar: true,
		hasShadow: false,
		// Float above EVERY app window and even fullscreen surfaces — the ghost
		// has to be visible while the cursor is over any other app.
		alwaysOnTop: true,
		acceptFirstMouse: false,
		webPreferences: {
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			devTools: false,
		},
	});
	window.setAlwaysOnTop(true, "screen-saver");
	window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	// Pointer events fall THROUGH the ghost to the windows underneath — the live
	// drag's hit-testing must see the real target, never the ghost.
	window.setIgnoreMouseEvents(true);

	let ready = false;
	let pending: { spec: DragGhostSpec; effect: DropEffect } | null = null;
	const push = (spec: DragGhostSpec, effect: DropEffect): void => {
		if (window.isDestroyed()) return;
		const arg = JSON.stringify({
			label: spec.label,
			iconRef: spec.iconRef ?? null,
			count: spec.count,
			effect: effectGlyph(effect),
			nodrop: effect === DropEffect.None,
		});
		window.webContents.executeJavaScript(`window.__ghost(${arg})`).catch(() => {});
	};
	window.webContents.on("did-finish-load", () => {
		ready = true;
		if (pending) {
			push(pending.spec, pending.effect);
			pending = null;
		}
	});
	void window.loadURL(GHOST_PAGE_URL);

	return {
		isDestroyed: () => window.isDestroyed(),
		setPosition: (x, y) => {
			if (!window.isDestroyed()) window.setPosition(x, y);
		},
		render: (spec, effect) => {
			if (window.isDestroyed()) return;
			if (ready) push(spec, effect);
			else pending = { spec, effect };
		},
		showInactive: () => {
			if (!window.isDestroyed()) window.showInactive();
		},
		hide: () => {
			if (!window.isDestroyed()) window.hide();
		},
	};
}
