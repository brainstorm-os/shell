/**
 * OS-file drop-zone plumbing (9.8.17): recognise a drag carrying files from
 * the OS (Finder / Explorer), keep an "is over" flag that survives the
 * enter/leave churn of nested children, and hand the dropped `File`s to the
 * caller. In-app object drags (which also arrive through HTML5 DnD) are
 * ignored, so a zone can be BOTH an object drop target and an OS-file one.
 *
 * `bindOsFileDrop` is the DOM twin for imperative surfaces (Database's
 * views); `useOsFileDrop` (./use-os-file-drop) is the React twin. Both run
 * the same `OsFileDragTracker`.
 */

import { ENTITY_DRAG_MIME } from "../entity-drag";

/** The DataTransfer type an OS file drag carries. */
const OS_FILES_TYPE = "Files";

type DragTypes = { readonly types: ArrayLike<string> | readonly string[] };

/** True when the drag carries OS files and none of the in-app drag MIMEs.
 *  `ignoreTypes` adds an app's own private drag MIME to the shared one. */
export function isOsFileDrag(
	dataTransfer: DragTypes | null | undefined,
	ignoreTypes: readonly string[] = [],
): boolean {
	if (!dataTransfer) return false;
	const types = Array.from(dataTransfer.types);
	if (!types.includes(OS_FILES_TYPE)) return false;
	if (types.includes(ENTITY_DRAG_MIME)) return false;
	return !ignoreTypes.some((type) => types.includes(type));
}

/** Enter/leave depth counter: `dragleave` fires when the pointer crosses
 *  into a child, so a boolean flips off mid-hover; counting enters against
 *  leaves keeps the zone lit until the pointer truly exits. */
export class OsFileDragTracker {
	private depth = 0;

	constructor(private readonly onOverChange: (over: boolean) => void) {}

	get over(): boolean {
		return this.depth > 0;
	}

	enter(): void {
		this.depth += 1;
		if (this.depth === 1) this.onOverChange(true);
	}

	leave(): void {
		if (this.depth === 0) return;
		this.depth -= 1;
		if (this.depth === 0) this.onOverChange(false);
	}

	reset(): void {
		const wasOver = this.depth > 0;
		this.depth = 0;
		if (wasOver) this.onOverChange(false);
	}
}

export type OsFileDropOptions = {
	onFiles(files: File[]): void;
	/** App-private drag MIMEs to leave alone (in addition to the shared
	 *  entity-drag MIME). */
	ignoreTypes?: readonly string[];
	onOverChange?(over: boolean): void;
	/** Gate the zone (e.g. a read-only/locked collection). Read per event. */
	enabled?(): boolean;
};

type DragEventLike = {
	readonly dataTransfer:
		| (DragTypes & { readonly files?: FileList | null; dropEffect?: string })
		| null;
	preventDefault(): void;
};

/** The four handlers a drop zone needs, over any event shape that carries a
 *  `dataTransfer` — React's synthetic `DragEvent` and the DOM's alike. */
export function createOsFileDropHandlers(options: OsFileDropOptions, tracker: OsFileDragTracker) {
	const accepts = (e: DragEventLike): boolean =>
		(options.enabled?.() ?? true) && isOsFileDrag(e.dataTransfer, options.ignoreTypes);
	return {
		onDragEnter(e: DragEventLike): void {
			if (!accepts(e)) return;
			e.preventDefault();
			tracker.enter();
		},
		onDragOver(e: DragEventLike): void {
			if (!accepts(e)) return;
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
		},
		onDragLeave(e: DragEventLike): void {
			if (!accepts(e)) return;
			tracker.leave();
		},
		onDrop(e: DragEventLike): void {
			if (!accepts(e)) return;
			e.preventDefault();
			tracker.reset();
			const files = Array.from(e.dataTransfer?.files ?? []);
			if (files.length > 0) options.onFiles(files);
		},
	};
}

/** Wire an element as an OS-file drop zone. Stamps `data-os-drop="true"`
 *  while a file drag hovers (style hook). Returns the unbind. */
export function bindOsFileDrop(element: HTMLElement, options: OsFileDropOptions): () => void {
	const tracker = new OsFileDragTracker((over) => {
		element.dataset.osDrop = over ? "true" : "false";
		options.onOverChange?.(over);
	});
	const handlers = createOsFileDropHandlers(options, tracker);
	const entries: Array<[string, (e: DragEvent) => void]> = [
		["dragenter", handlers.onDragEnter],
		["dragover", handlers.onDragOver],
		["dragleave", handlers.onDragLeave],
		["drop", handlers.onDrop],
	];
	for (const [type, handler] of entries) element.addEventListener(type, handler as EventListener);
	return () => {
		for (const [type, handler] of entries) {
			element.removeEventListener(type, handler as EventListener);
		}
		delete element.dataset.osDrop;
	};
}
