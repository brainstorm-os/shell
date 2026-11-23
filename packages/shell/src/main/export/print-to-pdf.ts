/**
 * Privileged HTML→PDF renderer for the `export` service (B11.12).
 *
 * Renders app-supplied, self-contained HTML in a **locked-down offscreen
 * BrowserWindow** and returns the PDF bytes. Security posture (defence in
 * depth — the caller's HTML comes from `serializedStateToHtml`, which already
 * escapes text + allowlists URL schemes, but this renderer assumes the input
 * is hostile):
 *
 *   - `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`,
 *     no preload — the page can reach no Node / Electron surface.
 *   - `javascript: false` — a static export never needs scripts, so JS is
 *     disabled outright; a smuggled `<script>` cannot run.
 *   - **All network is blocked** (`onBeforeRequest` cancels everything but
 *     the initial `data:` document) — the render can't phone home or leak
 *     which note was exported, and only `data:` images render.
 *   - Navigation, `window.open`, and every permission request are denied.
 *   - The window is always destroyed in a `finally`, and renders are
 *     **serialised** (one at a time) so a burst can't spawn N windows.
 *
 * Not unit-tested (needs Electron); the pure validation half lives in
 * `export-service-handler.ts` and the wiring is exercised in the real shell.
 */

import { BrowserWindow } from "electron";

/** A4-ish pixel box at 96dpi — only affects layout viewport, not the PDF
 *  page size (printToPDF sets that itself). */
const RENDER_WIDTH = 816;
const RENDER_HEIGHT = 1056;

/** Dedicated, in-memory (non-`persist:`) session for export renders. Critical:
 *  WITHOUT a partition the offscreen window shares the DEFAULT session, so the
 *  `onBeforeRequest` / permission handlers below would block networking +
 *  permissions for the ENTIRE shell. A named partition isolates them to export
 *  windows. */
const EXPORT_PARTITION = "bs-export-pdf";

/** Hard ceiling on a single render so a pathological document can't hang the
 *  serial queue forever. */
const RENDER_TIMEOUT_MS = 30_000;

/** Wrap body-level export HTML into a minimal, standards-mode document with a
 *  neutral print stylesheet. No external resources are referenced. */
function wrapDocument(bodyHtml: string): string {
	return [
		"<!doctype html>",
		'<html><head><meta charset="utf-8">',
		"<style>",
		"html,body{margin:0;padding:0;}",
		"body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;",
		"color:#111;line-height:1.5;padding:32px;}",
		"img{max-width:100%;}",
		"pre{white-space:pre-wrap;word-break:break-word;}",
		"table{border-collapse:collapse;}td,th{border:1px solid #ccc;padding:4px 8px;}",
		"</style></head><body>",
		bodyHtml,
		"</body></html>",
	].join("");
}

// Serialise renders: only one offscreen window is alive at a time, so a burst
// of export clicks can't spawn N privileged windows.
let queue: Promise<unknown> = Promise.resolve();

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			onTimeout();
			reject(new Error(`export render timed out after ${ms}ms`));
		}, ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

async function renderOnce(bodyHtml: string): Promise<Uint8Array> {
	const win = new BrowserWindow({
		show: false,
		width: RENDER_WIDTH,
		height: RENDER_HEIGHT,
		webPreferences: {
			// In-memory, export-only session — keeps the hardening handlers below
			// off the shell's default session.
			partition: EXPORT_PARTITION,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webSecurity: true,
			javascript: false,
			images: true,
			spellcheck: false,
		},
	});
	try {
		const contents = win.webContents;
		const ses = contents.session;
		// Deny everything that isn't "render this static document".
		ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
		ses.setPermissionCheckHandler(() => false);
		contents.setWindowOpenHandler(() => ({ action: "deny" }));
		contents.on("will-navigate", (event) => event.preventDefault());
		// Block all network — only the initial data: document is allowed (no
		// CSS url() / @import / <img src=http> egress, no file:// reads).
		ses.webRequest.onBeforeRequest((details, callback) => {
			callback({ cancel: !details.url.startsWith("data:") });
		});

		const doc = wrapDocument(bodyHtml);
		const render = (async () => {
			await contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(doc)}`);
			return contents.printToPDF({
				printBackground: true,
				pageSize: "A4",
			});
		})();
		const pdf = await withTimeout(render, RENDER_TIMEOUT_MS, () => {
			if (!win.isDestroyed()) win.destroy();
		});
		return new Uint8Array(pdf);
	} finally {
		if (!win.isDestroyed()) win.destroy();
	}
}

export function productionRenderHtmlToPdf(html: string): Promise<Uint8Array> {
	const run = queue.then(() => renderOnce(html));
	// Keep the chain alive regardless of this render's outcome.
	queue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}
