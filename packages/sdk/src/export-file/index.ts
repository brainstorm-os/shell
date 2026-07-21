/**
 * `@brainstorm-os/sdk/export-file` — shared helpers for the cross-app
 * "Save as file" flow that rides on the Stage 9.10 Files-host service.
 *
 * The consumer pattern is the same in every app:
 *   1. Encode the export to `Uint8Array` (text formats via `textToBytes`,
 *      vector formats by rasterising with `svgToPng`).
 *   2. Compose a default basename via `suggestedFilename`.
 *   3. Hand the encoder thunk + basename to `requestSaveBytes`, which
 *      runs `services.files.requestSave` then `services.files.write` and
 *      returns the disposition (`Saved | Cancelled | Failed`).
 *
 * Why extract at copy two (Graph 9.13.13b → Whiteboard 9.17.8b — per
 * [[extract-to-sdk-at-copy-two]]): the helpers are pure DOM/Web-Crypto
 * adapters with zero domain coupling; duplicating them risks drift on
 * the security-sensitive filename clamp + the raster cleanup invariants
 * (URL.revokeObjectURL in `finally`, scale clamp to [1, 8]). Centralise
 * once now so the third consumer (Files app drag-export, Database CSV
 * export, etc.) drops in trivially.
 *
 * Scope:
 *   - Pure / DOM-only — no React, no app types, no service binding. The
 *     `requestSaveBytes` orchestrator takes the Files surface as a
 *     parameter so it doesn't reach into any runtime singleton.
 *   - Tests run under jsdom for `suggestedFilename` (pure) +
 *     `textToBytes` (Web Crypto / TextEncoder, present in jsdom). The
 *     `svgToPng` raster branch is exercised by Playwright at 13.3 — jsdom
 *     does not actually decode SVG via `Image`, so a unit test would only
 *     prove the error-path. The cleanup-on-throw invariant (always
 *     revoke the blob URL) gets a dedicated test against an injected
 *     stub `Image` so the URL hygiene is regression-fenced.
 */

/** Minimal slice of `FilesService` (Stage 9.10) the save flow needs.
 *  Centralised here so apps don't need to depend on the full
 *  `@brainstorm-os/sdk-types` `FilesService` surface to wire one menu row. */
export type SaveFileTarget = {
	readonly handleId: string;
	readonly displayName: string;
};

export type SaveFileFilter = {
	readonly name: string;
	readonly extensions: readonly string[];
};

export type SaveFileService = {
	requestSave(opts?: {
		readonly title?: string;
		readonly filters?: readonly SaveFileFilter[];
		readonly suggestedName?: string;
	}): Promise<SaveFileTarget | null>;
	write(handle: SaveFileTarget, data: Uint8Array | ArrayBuffer): Promise<void>;
};

/** Result of a `requestSaveBytes` call. Three terminal states discriminated
 *  by `kind` so the caller (typically a menu's onSelect) can surface the
 *  right status string without branching on truthy / `instanceof Error`. */
export enum SaveDispositionKind {
	/** Bytes landed on disk. `handle.displayName` is the basename the user
	 *  picked (post-rename, post-extension-fixup); show it in the success
	 *  toast so the user can confirm where the file went. */
	Saved = "saved",
	/** User cancelled the picker. Not an error — mirrors the Files-host
	 *  `requestOpen → []` cancellation contract. */
	Cancelled = "cancelled",
	/** Encoder threw OR `requestSave`/`write` rejected. `error` carries the
	 *  underlying error so the caller can render a detail string and pipe
	 *  the stack to the runtime error log. */
	Failed = "failed",
}

export type SaveDisposition =
	| { readonly kind: SaveDispositionKind.Saved; readonly handle: SaveFileTarget }
	| { readonly kind: SaveDispositionKind.Cancelled }
	| { readonly kind: SaveDispositionKind.Failed; readonly error: unknown };

/** UTF-8 encode a string into a `Uint8Array`. Wraps `TextEncoder.encode`
 *  in a named function so call sites can be tested without recomputing
 *  the encoder per call (TextEncoder is cheap; we hoist for symmetry
 *  with future encoders that may have setup cost — keystroke-paint
 *  benchmark style). */
export function textToBytes(text: string): Uint8Array {
	return ENCODER.encode(text);
}
const ENCODER = new TextEncoder();

/** Filesystem chars that the major desktop OSes reject in a filename.
 *  Folded to `_` so the picker default never lands invalid. ASCII
 *  whitespace controls (`\n`, `\r`, `\t`) collapse too — a stem from a
 *  multi-line entity name shouldn't yield a default with literal control
 *  bytes. */
const FS_HOSTILE_RE = /[\\/:*?"<>|\n\r\t]+/g;

/** Stem cap. Some filesystems (encrypted-tmpfs HFS, exFAT) cap the full
 *  name near 255 bytes; capping the stem at 96 keeps room for a long
 *  extension and the user appending a suffix in the picker without
 *  hitting the OS limit. Picked empirically — wider than typical doc
 *  titles, narrower than a comfortable filename ceiling. */
const STEM_MAX = 96;

/** Compose a default basename for the save dialog: `<stem>.<extension>`,
 *  with `stem` cleaned of filesystem-hostile chars and capped at
 *  {@link STEM_MAX}. Returns `default.<ext>` when `stem` is null /
 *  undefined / empty / whitespace; the caller can override `defaultStem`
 *  to label the export with a domain-specific fallback ("graph",
 *  "board", "doc") instead. */
export function suggestedFilename(
	stem: string | null | undefined,
	extension: string,
	options?: { readonly defaultStem?: string },
): string {
	const fallback = options?.defaultStem ?? "untitled";
	const raw = (stem ?? "").trim() || fallback;
	const cleaned = raw.replace(FS_HOSTILE_RE, "_").slice(0, STEM_MAX);
	return `${cleaned}.${extension}`;
}

/** Rasterise an SVG string to a PNG `Uint8Array`. Runs in the renderer;
 *  uses standard Canvas API (no OffscreenCanvas dep, no worker plumbing —
 *  shipped after a measured-cost-threshold check on typical export
 *  sizes; the encoder thunk shields the call site for a future swap).
 *
 *  `scale` boosts the bitmap resolution above the SVG viewBox so the
 *  export looks crisp on hi-DPI targets without forcing the renderer to
 *  pick a pixel ceiling. v1 default is 2× (matches `devicePixelRatio`
 *  on a standard MacBook display). Clamped to [1, 8] — under 1 produces
 *  a downscaled image that defeats the purpose; over 8 risks main-thread
 *  jank on large canvases without a meaningful quality gain.
 *
 *  Cleanup invariant: `URL.revokeObjectURL` runs in a `finally`, so
 *  even an image-decode failure leaks zero blob URLs (regression-fenced
 *  in the test suite via an injected `Image` stub).
 *
 *  Errors fail loud — a silent "save succeeded" with a zero-byte PNG
 *  would confuse a user looking for the artefact.
 */
export async function svgToPng(
	svg: string,
	options?: { readonly scale?: number },
): Promise<Uint8Array> {
	const scale = Math.max(1, Math.min(8, options?.scale ?? 2));
	const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	try {
		const img = await loadImage(url);
		const baseW = img.naturalWidth || img.width || 800;
		const baseH = img.naturalHeight || img.height || 600;
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(baseW * scale));
		canvas.height = Math.max(1, Math.round(baseH * scale));
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("export-file/png: 2D context unavailable");
		ctx.scale(scale, scale);
		ctx.drawImage(img, 0, 0);
		const png = await canvasToBlob(canvas);
		const buffer = await png.arrayBuffer();
		return new Uint8Array(buffer);
	} finally {
		URL.revokeObjectURL(url);
	}
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("export-file/png: image decode failed"));
		img.src = src;
	});
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (blob) resolve(blob);
			else reject(new Error("export-file/png: canvas.toBlob returned null"));
		}, "image/png");
	});
}

/**
 * Orchestrate the Files-host save flow:
 *   1. `requestSave({title, suggestedName, filters})` — `null` ⇒ Cancelled.
 *   2. Encode bytes (thunk so PNG raster only runs after dialog commits).
 *   3. `write(handle, bytes)` — any throw above this point ⇒ Failed.
 *
 * Returns a {@link SaveDisposition} so the caller can render the right
 * status string without branching on truthy / `instanceof Error`. Never
 * throws — every error path collapses to `{kind: Failed, error}`.
 */
export async function requestSaveBytes(
	files: SaveFileService,
	opts: {
		readonly suggestedName: string;
		readonly filters: readonly SaveFileFilter[];
		readonly title?: string;
		readonly encode: () => Uint8Array | Promise<Uint8Array>;
	},
): Promise<SaveDisposition> {
	try {
		const handle = await files.requestSave({
			suggestedName: opts.suggestedName,
			filters: opts.filters,
			...(opts.title !== undefined ? { title: opts.title } : {}),
		});
		if (!handle) return { kind: SaveDispositionKind.Cancelled };
		const bytes = await opts.encode();
		await files.write(handle, bytes);
		return { kind: SaveDispositionKind.Saved, handle };
	} catch (error) {
		return { kind: SaveDispositionKind.Failed, error };
	}
}

/** Detail string from a `Failed` disposition. Hoisted so callers don't
 *  need to repeat the `instanceof Error` ternary at every menu row. */
export function failureDetail(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
