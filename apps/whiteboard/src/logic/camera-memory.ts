/**
 * Per-board viewport memory (9.17.24): reopening a board lands where you
 * left it — same pan, same zoom — while a board you have never opened on this
 * device still frames its content.
 *
 * Backed by the per-device `settings` service (app-namespaced, vault-scoped,
 * never synced): where you were looking is a device-local cursor, exactly
 * like `@brainstorm-os/sdk/last-viewed`. Everything is loaded once at boot so
 * opening a board reads the camera synchronously (no fit-then-jump flash);
 * writes are debounced per board, so a pan gesture is one write, not sixty a
 * second. Best-effort throughout — a shell without the service degrades to
 * "fit on every open".
 */

import type { SettingsService } from "@brainstorm-os/sdk-types";

export type Camera = { panX: number; panY: number; zoom: number };

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 3;
/** A fitted board never zooms in past 1:1 — a lone sticky should not open
 *  at 300%. */
export const FIT_MAX_ZOOM = 1;
export const FIT_PADDING = 48;
export const CAMERA_KEY_PREFIX = "camera:";
export const CAMERA_WRITE_DEBOUNCE_MS = 400;
/** Bounded so a device that opened thousands of boards keeps a small blob;
 *  past the cap the least-recently-touched board's camera is forgotten. */
export const MAX_REMEMBERED_CAMERAS = 200;

export const DEFAULT_CAMERA: Camera = Object.freeze({ panX: 0, panY: 0, zoom: 1 });

export function clampZoom(zoom: number): number {
	return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

/** A stored camera, or null when the value is not a finite, usable one. */
export function parseCamera(raw: unknown): Camera | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const { panX, panY, zoom } = r;
	if (typeof panX !== "number" || !Number.isFinite(panX)) return null;
	if (typeof panY !== "number" || !Number.isFinite(panY)) return null;
	if (typeof zoom !== "number" || !Number.isFinite(zoom) || zoom <= 0) return null;
	return { panX, panY, zoom: clampZoom(zoom) };
}

export function sameCamera(a: Camera, b: Camera): boolean {
	return a.panX === b.panX && a.panY === b.panY && a.zoom === b.zoom;
}

type Rect = { x: number; y: number; width: number; height: number };

/** The camera that frames every rect inside the viewport with padding,
 *  centred. No content or an unmeasured viewport → the default camera. */
export function fitCamera(
	rects: readonly Rect[],
	viewport: { width: number; height: number },
	padding: number = FIT_PADDING,
): Camera {
	if (rects.length === 0 || viewport.width <= 0 || viewport.height <= 0) return DEFAULT_CAMERA;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const r of rects) {
		minX = Math.min(minX, r.x);
		minY = Math.min(minY, r.y);
		maxX = Math.max(maxX, r.x + r.width);
		maxY = Math.max(maxY, r.y + r.height);
	}
	const contentW = Math.max(1, maxX - minX);
	const contentH = Math.max(1, maxY - minY);
	const zoom = clampZoom(
		Math.min(
			FIT_MAX_ZOOM,
			(viewport.width - padding * 2) / contentW,
			(viewport.height - padding * 2) / contentH,
		),
	);
	return {
		panX: viewport.width / 2 - (minX + contentW / 2) * zoom,
		panY: viewport.height / 2 - (minY + contentH / 2) * zoom,
		zoom,
	};
}

export type CameraMemory = {
	/** Prime the in-memory map from the settings store. */
	load(): Promise<void>;
	recall(boardId: string): Camera | null;
	/** Remember a board's camera; the write is debounced per board. */
	remember(boardId: string, camera: Camera): void;
	/** Write every pending camera now (window close / board switch). */
	flush(): void;
	dispose(): void;
};

type Timers = {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
};

const GLOBAL_TIMERS: Timers = {
	setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
	clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createCameraMemory(
	settings: SettingsService | null | undefined,
	options: { debounceMs?: number; timers?: Timers } = {},
): CameraMemory {
	const debounceMs = options.debounceMs ?? CAMERA_WRITE_DEBOUNCE_MS;
	const timers = options.timers ?? GLOBAL_TIMERS;
	const cameras = new Map<string, Camera>();
	const pending = new Map<string, unknown>();

	const write = (boardId: string): void => {
		pending.delete(boardId);
		const camera = cameras.get(boardId);
		if (!settings || !camera) return;
		void settings.put(`${CAMERA_KEY_PREFIX}${boardId}`, camera).catch(() => {
			/* device-local convenience — a failed write just means a refit */
		});
	};

	const evictOverflow = (): void => {
		while (cameras.size > MAX_REMEMBERED_CAMERAS) {
			const oldest = cameras.keys().next().value;
			if (oldest === undefined) return;
			cameras.delete(oldest);
			const handle = pending.get(oldest);
			if (handle !== undefined) timers.clearTimeout(handle);
			pending.delete(oldest);
			void settings?.delete(`${CAMERA_KEY_PREFIX}${oldest}`).catch(() => {});
		}
	};

	const flush = (): void => {
		for (const [boardId, handle] of [...pending]) {
			timers.clearTimeout(handle);
			write(boardId);
		}
	};

	return {
		async load() {
			if (!settings) return;
			try {
				const rows = await settings.list(CAMERA_KEY_PREFIX);
				for (const row of rows) {
					const camera = parseCamera(row.value);
					const boardId = row.key.slice(CAMERA_KEY_PREFIX.length);
					if (camera && boardId.length > 0 && !cameras.has(boardId)) cameras.set(boardId, camera);
				}
			} catch {
				/* no memory → every board fits on open */
			}
		},
		recall(boardId) {
			return cameras.get(boardId) ?? null;
		},
		remember(boardId, camera) {
			const previous = cameras.get(boardId);
			if (previous && sameCamera(previous, camera)) return;
			// Delete-then-set keeps Map insertion order = recency for eviction.
			cameras.delete(boardId);
			cameras.set(boardId, { ...camera });
			evictOverflow();
			const handle = pending.get(boardId);
			if (handle !== undefined) timers.clearTimeout(handle);
			pending.set(
				boardId,
				timers.setTimeout(() => write(boardId), debounceMs),
			);
		},
		flush,
		dispose: flush,
	};
}
