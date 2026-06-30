/**
 * Books — React chrome over the two imperative reading surfaces (the
 * all-apps-React rule: header / library / inspector are React; the reflow +
 * PDF readers stay imperative draw surfaces mounted behind refs).
 *
 * Layout: left panel = the live `Book/v1` library (ONE sanctioned
 * reactivity stack — `useLiveEntities` over a type-scoped `entities.query`,
 * never a hand-rolled onChange loop; the query keeps Books' narrow per-type
 * capability set rather than the `entities.read:*` wildcard the full
 * `vaultEntities.list()` snapshot demands); center = the reader; right = the
 * shared properties inspector
 * (cover + properties + table of contents) as a `.bs-props` glass overlay.
 *
 * Opening a book: a `Book/v1` whose format is PDF mounts the 9.21.5 PDF
 * reading mode (bytes fetched from the backing `File/v1`'s `brainstorm:`
 * URL, decoded by the shared `@brainstorm/sdk/pdf-engine`); an EPUB is parsed
 * by epub.js (lazy-loaded, 9.21.2) into `BookContent` and read through the same
 * reflow reader as the sample; a file-less preview record still shows the
 * "not built yet" notice. The in-memory sample book is OPT-IN from the empty
 * shelf (it no longer
 * auto-opens and masquerades as the user's library — F-224 territory).
 */

import { useLiveEntities } from "@brainstorm/react-yjs";
import type { CoversService, Entity } from "@brainstorm/sdk-types";
import { EmptyState } from "@brainstorm/sdk/empty-state";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import { recallLastViewed, rememberLastViewed } from "@brainstorm/sdk/last-viewed";
import { MenuAlign } from "@brainstorm/sdk/menus";
import { NavButtons, type NavHistory, createNavHistory } from "@brainstorm/sdk/nav-history";
import {
	type ObjectMenuExtraItem,
	type ObjectMenuRuntime,
	type OpenObjectMenuOptions,
	closeObjectMenu,
	openAnchoredMenu,
	openObjectMenu,
} from "@brainstorm/sdk/object-menu";
import { PanelSide, PanelToggleButton } from "@brainstorm/sdk/panel-toggle";
import type { PdfEngineDocument } from "@brainstorm/sdk/pdf-engine";
import { openPdfDocument, resolvePdfOutline } from "@brainstorm/sdk/pdf-engine";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { t } from "./i18n";
import {
	FILE_ENTITY_TYPE,
	IMPORT_EXTENSIONS,
	bookRecordFromImport,
	fileRecordFromImport,
	formatFromName,
	titleFromName,
} from "./logic/book-import";
import {
	bookFromEntity,
	entityIdFromPayload,
	fileSourceFromEntity,
	isOpenablePdfBook,
	readingPositionPatch,
	resolveFileOpen,
} from "./logic/book-open";
import { parseEpub } from "./logic/epub-parser";
import { booksFromEntities } from "./logic/library";
import { type PdfInfo, pdfEnrichmentPatch } from "./logic/pdf-metadata";
import { SAMPLE_BOOK_CONTENT, sampleBook } from "./logic/sample-book";
import { type TocEntry, tocFromContent, tocFromPdfOutline } from "./logic/toc";
import { renderPdfCover } from "./render/pdf-cover";
import { enginePagePort } from "./render/pdf-engine-port";
import type { PdfPagePort } from "./render/pdf-reader";
import { mountPdfReader } from "./render/pdf-reader";
import { mountReader } from "./render/reader";
import {
	type BooksEntitiesService,
	type BooksRuntime,
	type CreatedEntity,
	getBooksRuntime,
} from "./runtime";
import { BOOK_ENTITY_TYPE, type Book } from "./types/book";
import type { Locator } from "./types/locator";
import { BookInspector } from "./ui/inspector";
import { LibraryPanel } from "./ui/library-panel";

const SAMPLE_BOOK_ID = "sample-book";

/** Stable empty list so `useLiveEntities` doesn't re-render on identity. */
const EMPTY_BOOK_ROWS: readonly Entity[] = [];

/** Cheap shelf-equality: same rows in the same order with unchanged
 *  `updatedAt` — skips a re-render when an unrelated vault write fires the
 *  shared change signal. */
function bookRowsEqual(a: readonly Entity[], b: readonly Entity[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (!x || !y || x.id !== y.id || x.updatedAt !== y.updatedAt) return false;
	}
	return true;
}

/** Upper bound on a single open (fetch + pdf.js decode). A wedged asset
 *  fetch or a pdf.js worker that never initialises must surface the honest
 *  "couldn't open" state, never leave the reader spinning on "Opening book…". */
const OPEN_TIMEOUT_MS = 25_000;

/** Reject `promise` if it hasn't settled within `ms`. The underlying work is
 *  left to settle on its own (and is ignored) — the seq guard already drops a
 *  stale result. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`open timed out after ${ms}ms`)), ms);
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

async function fetchBookBytes(url: string): Promise<Uint8Array> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`fetch ${response.status}`);
	return new Uint8Array(await response.arrayBuffer());
}

/** Where the reader is — the open book's id (`null` = the empty shelf).
 *  Each user open pushes one of these so the shared back/forward control
 *  walks the books you've visited this session. */
type BooksLocation = { bookId: string | null };

enum ReaderStatus {
	Idle = "idle",
	Loading = "loading",
	Ready = "ready",
	Failed = "failed",
	EpubPending = "epub-pending",
}

type MountedReader = {
	dispose: () => void;
	goTo: (locator: Locator) => void;
};

/** Persist a page turn onto the `Book/v1` row. Each write chains off the
 *  previously-advanced book so progress/lastReadAt never regress. */
function makePositionPersister(
	entities: BooksEntitiesService | null,
	initial: Book,
	spineLength: number,
): (locator: Locator, progress: number) => void {
	let current = initial;
	return (locator, progress) => {
		const { book, patch } = readingPositionPatch(current, locator, progress, spineLength, Date.now());
		current = book;
		const update = entities?.update;
		if (!update) return;
		void Promise.resolve(update(book.id, patch)).catch((error) => {
			console.warn(`[books] reading-position write failed: ${(error as Error).message}`);
		});
	};
}

/** The new id off an `entities.create` reply, or `null` when malformed. */
function createdEntityId(entity: CreatedEntity): string | null {
	return typeof entity.id === "string" && entity.id.length > 0 ? entity.id : null;
}

/** Backfill catalog metadata from a freshly-opened PDF: author from the
 *  embedded info dictionary, a cover from the page-one render (stored in the
 *  vault cover store). Backfill-only — never clobbers a value the user set
 *  (see `pdfEnrichmentPatch`). Fire-and-forget; any failure is non-fatal to
 *  reading, so it degrades to a warn. */
async function enrichBookFromPdf(args: {
	doc: PdfEngineDocument;
	port: PdfPagePort;
	book: Book;
	rawProperties: Record<string, unknown> | null;
	entities: BooksEntitiesService | null;
	covers: CoversService | null;
	stillCurrent: () => boolean;
}): Promise<void> {
	const { doc, port, book, rawProperties, entities, covers, stillCurrent } = args;
	const update = entities?.update;
	if (!update) return;
	try {
		const info = (await doc.getMetadata().catch(() => null))?.info as PdfInfo | undefined;
		const hasCover = Boolean(rawProperties?.cover);
		let coverUrl: string | null = null;
		if (!hasCover && covers?.uploadBytes) {
			const png = await renderPdfCover(port);
			if (png && stillCurrent()) coverUrl = (await covers.uploadBytes("cover.png", png)).url;
		}
		if (!stillCurrent()) return;
		const patch = pdfEnrichmentPatch(info ?? null, {
			currentAuthor: book.author,
			currentName: book.name,
			fromFilename: book.name,
			hasCover,
			coverUrl,
		});
		if (Object.keys(patch).length > 0) await update(book.id, patch);
	} catch (error) {
		console.warn(`[books] metadata enrichment failed for ${book.id}: ${(error as Error).message}`);
	}
}

/** Narrow the Books runtime to exactly the structural slice the shared
 *  object menu reads — `capabilities` (gates Pin; Books holds none, so the
 *  Pin item never shows) + `intents.dispatch` (makes the Open item live, off
 *  the `intents.dispatch:open` grant). Without this the menu's Open was a
 *  permanently-disabled stub (F-228 — the ⋯ looked dead). */
function asObjectMenuRuntime(runtime: BooksRuntime): ObjectMenuRuntime {
	const dispatch = runtime.services?.intents?.dispatch;
	return {
		...(runtime.capabilities ? { capabilities: runtime.capabilities } : {}),
		services: {
			...(dispatch ? { intents: { dispatch } } : {}),
		},
	};
}

/** Right-panel open pref. Defaults CLOSED on first run (no stored value) —
 *  matches Notes/Journal/Files/Database; an opened panel persists. */
const INSPECTOR_PREF_KEY = "books:inspector-open";
function readInspectorPref(): boolean {
	// Open by default — selecting a book should surface its cover / properties
	// / contents inspector; only an explicit user-close (`"false"`) keeps it
	// shut. (Defaulting closed regressed the books-library + app.test.tsx
	// "inspector opens on select" expectation.)
	try {
		return localStorage.getItem(INSPECTOR_PREF_KEY) !== "false";
	} catch {
		return true;
	}
}
function writeInspectorPref(open: boolean): void {
	try {
		localStorage.setItem(INSPECTOR_PREF_KEY, String(open));
	} catch {
		// Storage disabled — pref reverts to default on reload.
	}
}

export function BooksApp(): ReactElement {
	const rt = useRef<BooksRuntime | undefined>(undefined);
	if (rt.current === undefined) rt.current = getBooksRuntime();
	const vaultEntitiesSvc = rt.current?.services?.vaultEntities ?? null;
	const entitiesSvc = rt.current?.services?.entities ?? null;
	const coversSvc = rt.current?.services?.covers ?? null;
	const usingVault = Boolean(vaultEntitiesSvc);

	// The shelf reads its OWN `Book/v1` rows through a type-scoped
	// `entities.query` (per-type capability, server-filtered) — NOT
	// `vaultEntities.list()`, which demands the `entities.read:*` wildcard
	// Books deliberately doesn't hold (that mismatch silently denied the list,
	// so imported books opened but never showed and "vanished" on restart).
	// `vaultEntities.onChange` is just the broadcast tap (no capability gate),
	// so it still drives live refresh.
	const bookListSource = useMemo(() => {
		const query = entitiesSvc?.query;
		if (!query) return null;
		return {
			list: () => query({ type: BOOK_ENTITY_TYPE }),
			...(vaultEntitiesSvc?.onChange
				? { onChange: (listener: () => void) => vaultEntitiesSvc.onChange(listener) }
				: {}),
		};
	}, [entitiesSvc, vaultEntitiesSvc]);
	const bookRows = useLiveEntities<Entity[]>(bookListSource, {
		initial: EMPTY_BOOK_ROWS as Entity[],
		equals: bookRowsEqual,
	});
	const books = useMemo(() => booksFromEntities(bookRows), [bookRows]);

	// Standalone preview (no vault) opens straight onto the sample book —
	// the only content it has. In the shell the shelf decides.
	const [selectedId, setSelectedId] = useState<string | null>(usingVault ? null : SAMPLE_BOOK_ID);

	const navRef = useRef<NavHistory<BooksLocation> | null>(null);
	if (navRef.current === null) {
		navRef.current = createNavHistory<BooksLocation>({
			initial: { bookId: usingVault ? null : SAMPLE_BOOK_ID },
			equals: (a, b) => a.bookId === b.bookId,
		});
	}
	const nav = navRef.current;

	// A user-initiated open: record it in history, then apply. Back/forward
	// replays selections via `applyLocation` (which must NOT push).
	const openBook = useCallback(
		(id: string | null) => {
			nav.push({ bookId: id });
			setSelectedId(id);
		},
		[nav],
	);
	const applyLocation = useCallback((loc: BooksLocation) => setSelectedId(loc.bookId), []);
	// Bumped to re-run the open effect for the SAME id (the launched-by-id
	// book arriving in a later snapshot).
	const [openNonce, setOpenNonce] = useState(0);
	const [status, setStatus] = useState<ReaderStatus>(ReaderStatus.Idle);
	const [toc, setToc] = useState<readonly TocEntry[]>([]);
	const [showLibrary, setShowLibrary] = useState(true);
	const [showInspector, setShowInspector] = useState(readInspectorPref);
	// A failed import used to vanish into a console.warn (the "Book never
	// appeared" report); surface it so the user knows what happened.
	const [importError, setImportError] = useState<string | null>(null);

	const stageRef = useRef<HTMLElement>(null);
	const controlsRef = useRef<HTMLSpanElement>(null);
	const readerRef = useRef<MountedReader | null>(null);
	const openSeqRef = useRef(0);
	// The id the snapshot-catch-up effect has already nudged. Bounds it to one
	// re-open per book so an un-openable book (e.g. no usable file URL) can
	// settle into `Failed` instead of being re-nudged on every render — the
	// re-nudge kept cancelling the in-flight open before it could fail, pinning
	// `status` on `Loading` forever (an infinite setState loop).
	const caughtUpRef = useRef<string | null>(null);

	const sample = useRef<Book | null>(null);
	if (sample.current === null) sample.current = sampleBook(Date.now());

	const booksRef = useRef(books);
	booksRef.current = books;

	// Latest selection, read by the async last-viewed restore so a user open
	// during the (awaited) staleness check is never clobbered.
	const selectedIdRef = useRef(selectedId);
	selectedIdRef.current = selectedId;
	const restoredLastViewedRef = useRef(false);

	// Latest raw rows, read by the on-open enrichment to tell whether a book
	// already carries a cover (never re-render or clobber a user-set one).
	const entitiesRef = useRef(bookRows);
	entitiesRef.current = bookRows;

	// Resolve a launch/intent target before navigating. A `Book/v1` opens
	// directly; a raw `File/v1` (a PDF the user opened from the Files app)
	// adopts-or-creates the `Book/v1` that wraps it so the reader has a catalog
	// record to mount — without this, opening a file in Books fell straight to
	// the "couldn't open" state because the reader only understands `Book/v1`.
	const openTarget = useCallback(
		async (entityId: string) => {
			if (booksRef.current.some((b) => b.id === entityId)) {
				openBook(entityId);
				return;
			}
			const get = rt.current?.services?.entities?.get;
			if (!get) {
				openBook(entityId);
				return;
			}
			let row: unknown;
			try {
				row = await get(entityId);
			} catch {
				openBook(entityId);
				return;
			}
			if ((row as { type?: unknown }).type !== FILE_ENTITY_TYPE) {
				openBook(entityId);
				return;
			}
			const resolved = resolveFileOpen({
				fileId: entityId,
				fileProps: (row as { properties?: Record<string, unknown> | null }).properties ?? null,
				books: booksRef.current,
				newBookId: `bk_${crypto.randomUUID()}`,
				now: Date.now(),
			});
			if (!resolved) {
				openBook(entityId);
				return;
			}
			if (resolved.record) {
				const create = entitiesSvc?.create;
				if (!create) {
					openBook(entityId);
					return;
				}
				try {
					await create(
						BOOK_ENTITY_TYPE,
						resolved.record as unknown as Record<string, unknown>,
						resolved.bookId,
					);
				} catch (error) {
					console.warn(`[books] failed to adopt file ${entityId}: ${(error as Error).message}`);
					openBook(entityId);
					return;
				}
			}
			openBook(resolved.bookId);
		},
		[openBook, entitiesSvc],
	);

	const isSample = selectedId === SAMPLE_BOOK_ID;
	const selectedBook = useMemo(() => {
		if (isSample) return sample.current;
		return selectedId ? (books.find((b) => b.id === selectedId) ?? null) : null;
	}, [isSample, selectedId, books]);

	// Launch handshake + later opens on the push channel. Both are real
	// navigations, so they go through `openBook` (history-recording).
	useEffect(() => {
		const runtime = rt.current;
		const launch = runtime?.launch;
		if (launch?.reason === "open-entity") {
			const id = entityIdFromPayload(launch);
			if (id) void openTarget(id);
		}
		runtime?.on?.("intent", (e) => {
			if (e.type !== "intent" || e.intent?.verb !== "open") return;
			const id = entityIdFromPayload(e.intent.payload ?? {});
			if (id) void openTarget(id);
		});
	}, [openTarget]);

	// Reopen the book the user was last reading when Books launches without an
	// explicit target (fresh / session-restore). The hint is device-local and
	// per-vault (`@brainstorm/sdk/last-viewed` over the settings service). A
	// since-deleted book is dropped silently — we stay on the shelf rather than
	// landing on a "couldn't open" state — and a user open during the awaited
	// staleness check wins (we only restore if the selection is still empty).
	useEffect(() => {
		if (restoredLastViewedRef.current) return;
		restoredLastViewedRef.current = true;
		const runtime = rt.current;
		if (!usingVault || runtime?.launch?.reason === "open-entity") return;
		void (async () => {
			const id = await recallLastViewed(runtime?.services?.settings ?? undefined);
			if (!id) return;
			const get = runtime?.services?.entities?.get;
			if (get) {
				try {
					if ((await get(id)) === null) return;
				} catch {
					return;
				}
			}
			if (selectedIdRef.current === null) void openTarget(id);
		})();
	}, [usingVault, openTarget]);

	// Remember the open book so the next launch lands back here. Clearing on the
	// empty shelf (selectedId === null) is intentional: returning to the shelf is
	// itself a location worth restoring to. The sample book is preview-only.
	useEffect(() => {
		if (!usingVault || selectedId === SAMPLE_BOOK_ID) return;
		void rememberLastViewed(rt.current?.services?.settings ?? undefined, selectedId);
	}, [usingVault, selectedId]);

	// Mount/swap the reading surface. Keyed on the selection identity ONLY —
	// snapshot churn (including our own reading-position writes) must not
	// remount the reader mid-read.
	// biome-ignore lint/correctness/useExhaustiveDependencies: openNonce is an intentional re-open key (the launched-by-id book arriving in a later snapshot), not a body dependency.
	useEffect(() => {
		const seq = ++openSeqRef.current;
		const stage = stageRef.current;
		const controls = controlsRef.current;
		if (!stage || !controls) return undefined;

		setToc([]);

		if (selectedId === null) {
			stage.replaceChildren();
			setStatus(ReaderStatus.Idle);
			return undefined;
		}

		if (selectedId === SAMPLE_BOOK_ID) {
			const handle = mountReader(stage, controls, SAMPLE_BOOK_CONTENT, {
				bookId: SAMPLE_BOOK_ID,
			});
			readerRef.current = { dispose: handle.dispose, goTo: handle.goTo };
			setToc(tocFromContent(SAMPLE_BOOK_CONTENT));
			setStatus(ReaderStatus.Ready);
			return () => {
				openSeqRef.current++;
				readerRef.current?.dispose();
				readerRef.current = null;
			};
		}

		stage.replaceChildren();
		setStatus(ReaderStatus.Loading);
		void (async () => {
			try {
				const get = rt.current?.services?.entities?.get;
				if (!get) throw new Error("entities service unavailable");
				// Resolve the book directly rather than waiting on the live vault
				// snapshot — a just-imported row may not have broadcast yet, and
				// that race left the reader stuck on "Opening book…" forever.
				let book = booksRef.current.find((b) => b.id === selectedId) ?? null;
				if (book === null) {
					const row = await get(selectedId);
					book = bookFromEntity(row as Parameters<typeof bookFromEntity>[0]);
				}
				if (seq !== openSeqRef.current) return;
				if (book === null) {
					setStatus(ReaderStatus.Failed);
					return;
				}
				if (!isOpenablePdfBook(book)) {
					// EPUB (9.21.2, OQ-BK-1 hybrid): epub.js parses the archive → the
					// pure extractor builds BookContent → the same reflow reader the
					// sample uses. A file-less preview record still shows the notice.
					if (!book.fileId) {
						setStatus(ReaderStatus.EpubPending);
						return;
					}
					const epubFileRow = await get(book.fileId);
					const epubSource = fileSourceFromEntity(
						epubFileRow as Parameters<typeof fileSourceFromEntity>[0],
					);
					if (!epubSource) throw new Error(`no usable file URL on ${book.fileId}`);
					const epubBytes = await withTimeout(fetchBookBytes(epubSource.url), OPEN_TIMEOUT_MS);
					const content = await withTimeout(parseEpub(epubBytes), OPEN_TIMEOUT_MS);
					if (seq !== openSeqRef.current) return;
					const persist = makePositionPersister(entitiesSvc, book, content.spine.length);
					const handle = mountReader(stage, controls, content, {
						bookId: book.id,
						initialPosition: book.reading.position,
						onPositionChange: persist,
					});
					readerRef.current = { dispose: handle.dispose, goTo: handle.goTo };
					setToc(tocFromContent(content));
					setStatus(ReaderStatus.Ready);
					return;
				}
				const fileRow = await get(book.fileId);
				const source = fileSourceFromEntity(fileRow as Parameters<typeof fileSourceFromEntity>[0]);
				if (!source) throw new Error(`no usable file URL on ${book.fileId}`);
				const bytes = await withTimeout(fetchBookBytes(source.url), OPEN_TIMEOUT_MS);
				const doc = await withTimeout(openPdfDocument(bytes), OPEN_TIMEOUT_MS);
				if (seq !== openSeqRef.current) {
					void doc.destroy().catch(() => {});
					return;
				}
				const port = enginePagePort(doc);
				const persist = makePositionPersister(entitiesSvc, book, doc.numPages);
				const title = book.name.length > 0 ? book.name : t("app.title");
				const handle = mountPdfReader(stage, controls, title, port, {
					initialPosition: book.reading.position,
					onPositionChange: persist,
					onOpenLink: (url) => {
						// Route page links through the `open` intent so web URLs land
						// in the browser app (the registered `https` opener) — Books
						// holds the `intents.dispatch:open` grant the menu's Open uses.
						void rt.current?.services?.intents?.dispatch?.({ verb: "open", payload: { url } });
					},
				});
				readerRef.current = {
					dispose: handle.dispose,
					goTo: (locator) => handle.goToPage(locator.spineIndex),
				};
				setStatus(ReaderStatus.Ready);
				const outline = await resolvePdfOutline(doc);
				if (seq === openSeqRef.current) setToc(tocFromPdfOutline(outline, doc.numPages));
				void enrichBookFromPdf({
					doc,
					port,
					book,
					rawProperties: entitiesRef.current.find((e) => e.id === book.id)?.properties ?? null,
					entities: entitiesSvc,
					covers: coversSvc,
					stillCurrent: () => seq === openSeqRef.current,
				});
			} catch (error) {
				if (seq !== openSeqRef.current) return;
				console.warn(`[books] failed to open ${selectedId}: ${(error as Error).message}`);
				setStatus(ReaderStatus.Failed);
			}
		})();

		return () => {
			openSeqRef.current++;
			readerRef.current?.dispose();
			readerRef.current = null;
		};
		// `isOpenablePdfBook` depends only on fields that are fixed for a given
		// id (format / fileId), so id + nonce is the full open identity.
	}, [selectedId, openNonce, entitiesSvc]);

	// Re-arm the one-shot catch-up for each genuinely new selection (keyed on
	// `selectedId`, so an `openNonce` re-open doesn't re-arm it and re-enter the
	// loop the dedup exists to prevent).
	// biome-ignore lint/correctness/useExhaustiveDependencies: selectedId is an intentional trigger, not read in the body — re-arm the one-shot on each new selection
	useEffect(() => {
		caughtUpRef.current = null;
	}, [selectedId]);

	// A vault book that wasn't in the snapshot at open time (launched by id
	// before the first snapshot landed) opens once the shelf catches up.
	useEffect(() => {
		if (status !== ReaderStatus.Loading || selectedId === null || isSample) return;
		if (readerRef.current) return;
		if (caughtUpRef.current === selectedId) return;
		if (books.some((b) => b.id === selectedId)) {
			caughtUpRef.current = selectedId;
			setOpenNonce((n) => n + 1);
		}
	}, [books, status, selectedId, isSample]);

	const patchBook = useCallback(
		(patch: Record<string, unknown>) => {
			if (!selectedId || selectedId === SAMPLE_BOOK_ID) return;
			void entitiesSvc?.update?.(selectedId, patch)?.catch((error) => {
				console.warn(`[books] property write failed: ${(error as Error).message}`);
			});
		},
		[entitiesSvc, selectedId],
	);

	const removeBook = useCallback(() => {
		if (!selectedId || selectedId === SAMPLE_BOOK_ID) return;
		void entitiesSvc?.delete?.(selectedId)?.catch((error) => {
			console.warn(`[books] remove failed: ${(error as Error).message}`);
		});
		openBook(null);
	}, [entitiesSvc, selectedId, openBook]);

	// Import a book: pick one-or-more EPUB/PDF files, seal each into the
	// encrypted asset store (`files.import` — bytes never cross IPC on the
	// picker path), then write a `File/v1` + a `Book/v1` pointing at it.
	// Opens the last-imported book so the user lands on what they just added.
	const importBook = useCallback(async () => {
		setImportError(null);
		const filesSvc = rt.current?.services?.files;
		const create = entitiesSvc?.create;
		if (!filesSvc?.requestOpen || !filesSvc.import || !create) {
			console.warn("[books] import unavailable: no files service");
			setImportError(t("import.unavailable"));
			return;
		}
		let handles: readonly { handleId: string; displayName: string }[];
		try {
			handles = await filesSvc.requestOpen({
				title: t("import.dialogTitle"),
				filters: [{ name: t("import.fileKind"), extensions: IMPORT_EXTENSIONS }],
				multi: true,
			});
		} catch (error) {
			console.warn(`[books] import picker failed: ${(error as Error).message}`);
			setImportError(t("import.pickerFailed"));
			return;
		}
		if (handles.length === 0) return;

		let lastBookId: string | null = null;
		const failed: string[] = [];
		for (const handle of handles) {
			const format = formatFromName(handle.displayName);
			if (!format) {
				failed.push(handle.displayName);
				continue;
			}
			try {
				const reply = await filesSvc.import({ handle });
				const fileEntity = await create(FILE_ENTITY_TYPE, fileRecordFromImport(reply));
				const fileId = createdEntityId(fileEntity);
				if (!fileId) throw new Error("created file has no id");
				const bookId = `bk_${crypto.randomUUID()}`;
				const record = bookRecordFromImport({
					id: bookId,
					fileId,
					title: titleFromName(handle.displayName),
					format,
					now: Date.now(),
				});
				await create(BOOK_ENTITY_TYPE, record as unknown as Record<string, unknown>, bookId);
				lastBookId = bookId;
			} catch (error) {
				console.warn(
					`[books] ${t("import.failed", { name: handle.displayName })}: ${(error as Error).message}`,
				);
				failed.push(handle.displayName);
			}
		}
		if (lastBookId) openBook(lastBookId);
		// Only surface failures when nothing landed — a partial multi-import
		// that opened at least one book shouldn't nag about the rest.
		if (!lastBookId && failed.length > 0) {
			setImportError(t("import.failed", { name: failed.join(", ") }));
		}
	}, [entitiesSvc, openBook]);

	const canImport = Boolean(rt.current?.services?.files?.import && entitiesSvc?.create);

	const navigateTo = useCallback((locator: Locator) => {
		readerRef.current?.goTo(locator);
	}, []);

	const subject = useMemo(() => {
		if (!selectedBook) return null;
		if (isSample) return { id: SAMPLE_BOOK_ID, properties: {} };
		const raw = bookRows.find((e) => e.id === selectedBook.id);
		return { id: selectedBook.id, properties: raw?.properties ?? {} };
	}, [selectedBook, isSample, bookRows]);

	const menuContext = useCallback((): OpenObjectMenuOptions | null => {
		if (!selectedBook || isSample) return null;
		return {
			target: {
				entityId: selectedBook.id,
				entityType: BOOK_ENTITY_TYPE,
				label: selectedBook.name,
			},
			runtime: rt.current ? asObjectMenuRuntime(rt.current) : null,
			labels: { remove: t("menu.remove") },
			// The header ⋯ acts on the book already open in this window, so
			// "Open" would re-open the current view (a no-op) — drop it.
			omitOpen: true,
			onRemove: removeBook,
		};
	}, [selectedBook, isSample, removeBook]);

	// Library view-level actions the ⋯ always offers, independent of a selected
	// book — so the trailing overflow is never inert in the default library
	// state (F-249). Mirrors Graph's view-actions ⋯ pattern: shown as object-menu
	// extra items when a book is bound, and as the whole menu when none is.
	const libraryViewActions = useCallback((): ObjectMenuExtraItem[] => {
		const items: ObjectMenuExtraItem[] = [];
		if (canImport) {
			items.push({
				id: "import-book",
				label: t("library.importBook"),
				icon: IconName.Plus,
				run: () => void importBook(),
			});
		}
		items.push({
			id: "toggle-library",
			label: showLibrary ? t("library.hide") : t("library.show"),
			icon: IconName.View,
			run: () => setShowLibrary((v) => !v),
		});
		return items;
	}, [canImport, importBook, showLibrary]);

	const headerMoreRef = useRef<HTMLButtonElement>(null);
	useEffect(() => closeObjectMenu, []);
	const openHeaderMenu = useCallback(() => {
		const el = headerMoreRef.current;
		if (!el) return;
		const r = el.getBoundingClientRect();
		const point = { x: r.left, y: r.bottom + 4 };
		const viewActions = libraryViewActions();
		const ctx = menuContext();
		if (ctx) {
			void openObjectMenu(point, {
				...ctx,
				extraItems: [...(ctx.extraItems ?? []), ...viewActions],
				anchor: el,
				align: MenuAlign.End,
			});
			return;
		}
		openAnchoredMenu(
			point,
			viewActions.map((a) => ({
				label: a.label,
				onSelect: a.run,
				...(a.icon ? { icon: a.icon } : {}),
			})),
			{ menuLabel: t("menu.more"), anchor: el, align: MenuAlign.End },
		);
	}, [libraryViewActions, menuContext]);

	const title = selectedBook ? selectedBook.name || t("library.sampleName") : t("app.title");

	return (
		<div className="books-shell">
			<header className="app-header">
				<div className="app-header__left">
					<NavButtons history={nav} onNavigate={applyLocation} />
					<h1 className="app-header__title">{title}</h1>
					{isSample ? <span className="books__preview-badge">{t("reader.previewBadge")}</span> : null}
				</div>
				<div className="app-header__right">
					{canImport ? (
						<button
							type="button"
							className="header-icon-btn"
							onClick={() => void importBook()}
							aria-label={t("library.importBook")}
							data-bs-tooltip={t("library.importBook")}
						>
							<Icon name={IconName.Plus} size={16} />
						</button>
					) : null}
					<span className="books__reader-controls" ref={controlsRef} />
					<PanelToggleButton
						side={PanelSide.Left}
						open={showLibrary}
						onClick={() => setShowLibrary((v) => !v)}
						labels={{ show: t("library.show"), hide: t("library.hide") }}
						controls="books-library"
					/>
					<PanelToggleButton
						side={PanelSide.Right}
						open={showInspector}
						onClick={() =>
							setShowInspector((v) => {
								writeInspectorPref(!v);
								return !v;
							})
						}
						labels={{ show: t("inspector.show"), hide: t("inspector.hide") }}
						disabled={!selectedBook}
					/>
					<button
						ref={headerMoreRef}
						type="button"
						className="bs-object-menu__more"
						aria-haspopup="menu"
						aria-label={t("menu.more")}
						data-bs-tooltip={t("menu.more")}
						onClick={openHeaderMenu}
					>
						<span className="bs-object-menu__more-dot" />
						<span className="bs-object-menu__more-dot" />
						<span className="bs-object-menu__more-dot" />
					</button>
				</div>
			</header>
			<div className="books__layout" data-library-open={showLibrary ? "true" : "false"}>
				<LibraryPanel
					books={books}
					selectedId={selectedId}
					open={showLibrary}
					onSelect={openBook}
					onImport={canImport ? importBook : undefined}
					importError={importError}
					onDismissError={() => setImportError(null)}
				/>
				<div className="books__content">
					<main className="books" ref={stageRef} />
					{status !== ReaderStatus.Ready ? (
						<div className="books__placeholder">
							<ReaderNotice status={status} hasBooks={books.length > 0} usingVault={usingVault} />
						</div>
					) : null}
				</div>
				{selectedBook && subject ? (
					<BookInspector
						book={selectedBook}
						subject={subject}
						toc={toc}
						open={showInspector}
						readOnly={isSample}
						onPatch={patchBook}
						onNavigate={navigateTo}
						onClose={() => {
							writeInspectorPref(false);
							setShowInspector(false);
						}}
					/>
				) : null}
			</div>
		</div>
	);
}

function ReaderNotice({
	status,
	hasBooks,
	usingVault,
}: {
	status: ReaderStatus;
	hasBooks: boolean;
	usingVault: boolean;
}): ReactElement {
	// Loading is a momentary state on every book open — a flashing glyph chip
	// reads worse than a quiet line, so it stays plain text.
	if (status === ReaderStatus.Loading) {
		return <p className="books__notice-text">{t("reader.loading")}</p>;
	}
	if (status === ReaderStatus.Failed) {
		return <EmptyState icon={IconName.Warning} title={t("reader.loadFailed")} />;
	}
	if (status === ReaderStatus.EpubPending) {
		return (
			<EmptyState
				icon={IconName.View}
				title={t("reader.epubPendingTitle")}
				hint={t("reader.epubPending")}
			/>
		);
	}
	if (usingVault && !hasBooks) {
		return (
			<EmptyState
				icon={IconName.View}
				title={t("reader.emptyLibraryTitle")}
				hint={t("reader.emptyLibraryHint")}
			/>
		);
	}
	return <EmptyState icon={IconName.View} title={t("reader.empty")} hint={t("reader.none")} />;
}
