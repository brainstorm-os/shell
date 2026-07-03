/**
 * Preview host (React, 9.20.12). Apple Quick Look feel — a filename +
 * counter + arrow nav, the render pane fills the rest, an optional inspector
 * sits on the right per [[app-panel-sides]]. The chrome (header, inspector,
 * filmstrip, empty/unavailable states) is React; the per-kind renderer
 * modules stay imperative behind the `<RenderSurface>` ref boundary per
 * [[preview-drop-pattern]] — so 9.20.2 (image) … 9.20.5 (PDF) plug in via the
 * existing per-kind registry without this file changing.
 *
 * Cross-app open: a fresh launch resolves a bare entity id via the
 * capability-gated `entities.get`; an already-running window receives the
 * enriched `{ context, siblings }` push through `runtime.on("intent")`.
 */

import { RightPanelTab } from "@brainstorm/editor";
import { EmptyState } from "@brainstorm/sdk/empty-state";
import { requestSaveBytes } from "@brainstorm/sdk/export-file";
import { IconName } from "@brainstorm/sdk/icon";
import { readPanelOpen, writePanelOpen } from "@brainstorm/sdk/panel-state";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PreviewFile } from "./demo/dataset";
import { type GalleryState, resolveOpenPayload, toPreviewFiles } from "./host/apply-open";
import { chipLabelFor } from "./host/context-label";
import { indexOfId, jumpTo, step } from "./host/host-state";
import {
	type OpenPayload,
	type PreviewContextSibling,
	type PreviewRuntime,
	getPreviewRuntime,
} from "./host/runtime";
import { useVaultFiles } from "./host/use-vault-files";
import { t } from "./i18n";
import { entityToPreviewFile } from "./logic/entity-to-file";
import { type PreviewContext, PreviewContextKind } from "./types/preview-context";
import { FileSidebar } from "./ui/file-sidebar";
import { Filmstrip } from "./ui/filmstrip";
import { HeaderActions } from "./ui/header-actions";
import { Inspector, type InspectorPairs } from "./ui/inspector";
import { Nav } from "./ui/nav";
import { RenderSurface } from "./ui/render-surface";
import { SourceChip } from "./ui/source-chip";
import { usePreviewShortcuts } from "./ui/use-preview-shortcuts";

const EMPTY_SIBLINGS: ReadonlyArray<PreviewFile> = [];
const EMPTY_PAIRS: InspectorPairs = [];

/** Resolve a bare entity id to a single renderable file via the
 *  capability-gated `entities.get`. Returns `null` on any failure so the
 *  host keeps its honest empty/"no preview" state. */
async function resolveEntityFile(
	runtime: PreviewRuntime | undefined,
	entityId: string,
): Promise<PreviewFile | null> {
	const get = runtime?.services?.entities?.get;
	if (typeof get !== "function") return null;
	try {
		const entity = await get(entityId);
		return entityToPreviewFile(entity as Parameters<typeof entityToPreviewFile>[0]);
	} catch {
		return null;
	}
}

/** The two navigation verbs Preview answers to. `quick-look` is Preview's
 *  primary registration; `open` is its secondary fallback. */
const PREVIEW_INTENT_VERBS = new Set<string>(["open", "quick-look"]);

/** Trailing extension of a filename (no dot), lowercased — used for the
 *  save dialog's filter so the user keeps the file's native format. */
function extensionOf(name: string): string | null {
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return null;
	return name.slice(dot + 1).toLowerCase();
}

/** Right-panel open state — window-scoped (`@brainstorm/sdk/panel-state`):
 *  a fresh Preview window always starts with the inspector closed. */
const INSPECTOR_PREF_KEY = "preview:inspector-open";
function readInspectorPref(): boolean {
	return readPanelOpen(INSPECTOR_PREF_KEY, false);
}
function writeInspectorPref(open: boolean): void {
	writePanelOpen(INSPECTOR_PREF_KEY, open);
}

/** Left library-sidebar open pref. With no stored value the sidebar defaults
 *  OPEN when Preview is launched with nothing to show (the empty-app case this
 *  feature fixes) and CLOSED when launched onto a specific file (Quick Look
 *  should feel like a focused lightbox). An explicit toggle persists. */
const SIDEBAR_PREF_KEY = "preview:sidebar-open";
function readSidebarPref(): boolean | null {
	try {
		const stored = localStorage.getItem(SIDEBAR_PREF_KEY);
		return stored === null ? null : stored === "true";
	} catch {
		return null;
	}
}
function writeSidebarPref(open: boolean): void {
	try {
		localStorage.setItem(SIDEBAR_PREF_KEY, String(open));
	} catch {
		// Storage disabled — pref reverts to default on reload.
	}
}
function initialSidebarOpen(): boolean {
	const stored = readSidebarPref();
	if (stored !== null) return stored;
	const launch = getPreviewRuntime()?.launch;
	return !(launch && launch.reason === "open-entity");
}

export function PreviewApp(): ReactElement {
	const [siblings, setSiblings] = useState<ReadonlyArray<PreviewFile>>(EMPTY_SIBLINGS);
	const [cursor, setCursor] = useState(0);
	const [context, setContext] = useState<PreviewContext | null>(null);
	const [inspectorOpen, setInspectorOpen] = useState(readInspectorPref);
	const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);
	const [pairs, setPairs] = useState<InspectorPairs>(EMPTY_PAIRS);
	const [rightTab, setRightTab] = useState<RightPanelTab>(RightPanelTab.Properties);

	// The library sidebar reads the vault's previewable `File/v1` rows live
	// through the shared reactivity stack. `getPreviewRuntime()` is a stable
	// singleton (window.brainstorm), so the memo binds the query source once.
	const runtime = useMemo(() => getPreviewRuntime(), []);
	const vaultFiles = useVaultFiles(runtime);

	const total = siblings.length;
	const activeFile = total > 0 ? (siblings[cursor] ?? null) : null;
	const navUsable = total > 1;

	// Read the live gallery in callbacks that must not close over stale state.
	const siblingsRef = useRef(siblings);
	siblingsRef.current = siblings;
	const cursorRef = useRef(cursor);
	cursorRef.current = cursor;
	const contextRef = useRef(context);
	contextRef.current = context;

	const applyGallery = useCallback((next: GalleryState): void => {
		setPairs(EMPTY_PAIRS);
		const list = next.siblings;
		setSiblings(list);
		setContext(next.context);
		const focusIndex = next.focusId != null ? list.findIndex((f) => f.id === next.focusId) : 0;
		setCursor(focusIndex >= 0 ? focusIndex : 0);
	}, []);

	const navigateTo = useCallback((index: number): void => {
		setCursor((prev) => {
			const state = jumpTo({ siblings: siblingsRef.current, cursor: prev }, index);
			return state.cursor;
		});
	}, []);

	const stepBy = useCallback((delta: number): void => {
		setCursor((prev) => step({ siblings: siblingsRef.current, cursor: prev }, delta).cursor);
	}, []);

	const focusById = useCallback(
		(id: string): void => {
			const found = indexOfId({ siblings: siblingsRef.current, cursor: 0 }, id);
			if (found >= 0) navigateTo(found);
		},
		[navigateTo],
	);

	const toggleInspector = useCallback(
		() =>
			setInspectorOpen((v) => {
				writeInspectorPref(!v);
				return !v;
			}),
		[],
	);

	const closeInspector = useCallback(() => {
		setInspectorOpen(false);
		writeInspectorPref(false);
	}, []);

	const toggleSidebar = useCallback(
		() =>
			setSidebarOpen((v) => {
				writeSidebarPref(!v);
				return !v;
			}),
		[],
	);

	// Open a file picked from the library sidebar: a single-file gallery (the
	// sidebar itself is the navigator, so the filmstrip stays collapsed). Reuses
	// the same `applyGallery` path as a cross-app `intent.open`.
	const openLibraryFile = useCallback(
		(file: PreviewFile): void => {
			applyGallery({ context: null, siblings: [file], focusId: file.id });
		},
		[applyGallery],
	);

	// Write the currently-viewed file out to a user-chosen location. Bytes
	// sources write directly; url sources (brainstorm://asset) are fetched —
	// Preview's CSP `connect-src` allows the brainstorm scheme.
	const saveCopy = useCallback(async (): Promise<void> => {
		const files = getPreviewRuntime()?.services?.files;
		const file = siblingsRef.current[cursorRef.current];
		if (!files || !file) return;
		const { source, info } = file;
		const ext = extensionOf(info.name);
		await requestSaveBytes(files, {
			suggestedName: info.name,
			title: t("menu.saveDialogTitle"),
			filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : [],
			encode: async () => {
				if (source.kind === "bytes") return source.bytes;
				const res = await fetch(source.url);
				return new Uint8Array(await res.arrayBuffer());
			},
		});
	}, []);

	const canSaveCopy = activeFile != null && Boolean(getPreviewRuntime()?.services?.files);

	usePreviewShortcuts({
		onPrev: () => stepBy(-1),
		onNext: () => stepBy(1),
		onFirst: () => navigateTo(0),
		onLast: () => navigateTo(siblingsRef.current.length - 1),
		onToggleInspector: toggleInspector,
	});

	// Apply an open payload → next gallery state. Stable across renders so the
	// intent subscription binds once.
	const applyOpen = useCallback(
		async (payload: OpenPayload): Promise<boolean> => {
			const runtime = getPreviewRuntime();
			const next = await resolveOpenPayload(payload, siblingsRef.current, (id) =>
				resolveEntityFile(runtime, id),
			);
			if (!next) return false;
			applyGallery(next);
			return true;
		},
		[applyGallery],
	);

	// Launch handshake + the `app:intent` push channel.
	useEffect(() => {
		const runtime = getPreviewRuntime();
		const launch = runtime?.launch;
		if (launch && launch.reason === "open-entity") {
			void applyOpen(launch);
		}
		const sub = runtime?.on?.("intent", (e) => {
			if (e.type !== "intent" || !e.intent || !PREVIEW_INTENT_VERBS.has(e.intent.verb ?? "")) {
				return;
			}
			void applyOpen(e.intent.payload ?? {});
		});
		return () => {
			if (sub && typeof sub === "object" && "unsubscribe" in sub) {
				(sub as { unsubscribe?: () => void }).unsubscribe?.();
			}
		};
	}, [applyOpen]);

	// Dev console / Playwright probe — stable surface, stripped in a future
	// hardening pass.
	useEffect(() => {
		if (!import.meta.env.DEV) return;
		window.__previewHost = {
			getCursor: () => cursorRef.current,
			goTo: navigateTo,
			focusById,
			getContextLabel: () => contextRef.current?.label ?? null,
			applyContext: (ctx, sibs, focusId) => {
				const list = sibs && sibs.length > 0 ? toPreviewFiles(sibs) : EMPTY_SIBLINGS;
				applyGallery({ context: ctx, siblings: list, focusId: focusId ?? null });
			},
		};
		return () => {
			window.__previewHost = undefined;
		};
	}, [navigateTo, focusById, applyGallery]);

	const chip = useMemo(() => chipLabelFor(context, total), [context, total]);
	const counterText =
		total > 0 ? t("counter.position", { index: cursor + 1, total }) : t("counter.empty");

	const rootClass = [
		"preview",
		total === 0 ? "preview--empty" : "",
		inspectorOpen ? "" : "preview--inspector-collapsed",
		sidebarOpen ? "" : "preview--sidebar-collapsed",
	]
		.filter(Boolean)
		.join(" ");

	return (
		<>
			<header className="app-header" data-testid="app-header">
				<div className="app-header__left">
					<Nav
						disabled={!navUsable}
						counter={counterText}
						onPrev={() => stepBy(-1)}
						onNext={() => stepBy(1)}
					/>
					{chip ? <SourceChip kind={chip.kind} label={chip.label} /> : null}
					<span className="app-header__title preview__filename" title={activeFile?.info.name ?? ""}>
						{activeFile?.info.name ?? ""}
					</span>
				</div>
				<div className="app-header__right">
					<HeaderActions
						sidebarOpen={sidebarOpen}
						onToggleSidebar={toggleSidebar}
						inspectorOpen={inspectorOpen}
						onToggleInspector={toggleInspector}
						onSaveCopy={canSaveCopy ? () => void saveCopy() : undefined}
					/>
				</div>
			</header>
			<main className={rootClass} id="preview-root">
				<FileSidebar files={vaultFiles} activeId={activeFile?.id ?? null} onOpen={openLibraryFile} />
				<div className="preview__main">
					<div className="preview__body">
						<div className="preview__stage">
							{activeFile ? (
								<RenderSurface key={activeFile.id} file={activeFile} onMetadata={setPairs} />
							) : (
								<EmptyState
									icon={IconName.View}
									title={t("stage.noFileSelected")}
									hint={t("stage.noFileSelectedHint")}
								/>
							)}
						</div>
						<aside className="preview__inspector glass--strong">
							<Inspector
								runtime={runtime}
								file={activeFile?.info ?? null}
								entityId={activeFile?.id ?? null}
								pairs={pairs}
								activeTab={rightTab}
								onTabChange={setRightTab}
								onClose={closeInspector}
							/>
						</aside>
					</div>
					<Filmstrip siblings={siblings} cursor={cursor} onNavigate={navigateTo} />
				</div>
			</main>
		</>
	);
}

export type { PreviewContext, PreviewContextSibling };
export { PreviewContextKind };
