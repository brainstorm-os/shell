/**
 * Code-Editor — React app (all-apps-React track). Mirrors the theme-editor
 * reference conversion (9.9.7): a React root mounts the chrome (header, file
 * sidebar, references inspector, empty state), live vault data is read ONLY
 * through `@brainstorm-os/react-yjs` (`useVaultEntities`), and the editing
 * surface is an imperative island (`createCodePane`) confined behind a ref
 * boundary — the same posture Graph/Whiteboard use for their draw loops.
 *
 * Posture mirrors every migrated read-half app: in shell mode the ONLY
 * source is the vault-entities aggregator (real `entities.db` `CodeFile/v1`
 * rows); the in-memory demo is for standalone-dev (`!window.brainstorm`)
 * only, per [[preview-drop-pattern]].
 *
 * Editing round-trips through the Y.Doc resolver transparently; the explicit
 * Save chord denormalises the body back into the entity property bag (the v1
 * read path still sources `content` from properties).
 */

import { useVaultEntities } from "@brainstorm-os/react-yjs";
import { NavigationMode, navModeFromEvent, openEntity } from "@brainstorm-os/sdk";
import type { VaultEntitiesService } from "@brainstorm-os/sdk-types";
import { EmptyState, EmptyStateTone } from "@brainstorm-os/sdk/empty-state";
import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import { recallLastViewed, rememberLastViewed } from "@brainstorm-os/sdk/last-viewed";
import { LockButton } from "@brainstorm-os/sdk/lock-button";
import { NavButtons, createNavHistory } from "@brainstorm-os/sdk/nav-history";
import {
	ObjectMenuMoreButton,
	ObjectMenuTrigger,
	openObjectMenu,
} from "@brainstorm-os/sdk/object-menu";
import { readPanelOpen, writePanelOpen } from "@brainstorm-os/sdk/panel-state";
import { PanelSide, PanelToggleButton } from "@brainstorm-os/sdk/panel-toggle";
import { PopoverSize, createPopoverElement } from "@brainstorm-os/sdk/popover";
import { PresenceStack, usePresence, useSelf } from "@brainstorm-os/sdk/presence-stack";
import { SelectMenu } from "@brainstorm-os/sdk/select-menu";
import { type ShortcutDisposer, attachShortcut } from "@brainstorm-os/sdk/shortcut";
import { publishTabIdentity } from "@brainstorm-os/sdk/tab-identity";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildCodeDemo, buildDemoCitationIndex } from "./demo/dataset";
import { type CodeEditorMessageKey, plural as appPlural, t } from "./i18n";
import { useCodeEditorPlural, useCodeEditorT } from "./i18n-hooks";
import { type CitationIndex, CitationKind, buildCitationIndex } from "./logic/citation-index";
import { type CitationReference, collectReferences } from "./logic/citation-scan";
import { type CodeFileRow, isCodeFileEditable, projectCodeFiles } from "./logic/code-projection";
import { fileName, languageLabel } from "./logic/code-view";
import type { EditorCommand } from "./logic/command-palette";
import { lintCode } from "./logic/diagnostics";
import { languageAfterRename } from "./logic/language-detect";
import {
	type FolderPlan,
	type FolderPlanFile,
	type PathMove,
	RenameError,
	nextFolderPath,
	nextUntitledPath,
	planFileMove,
	planFolderMove,
	planFolderRename,
	validateRenamePath,
} from "./logic/new-file";
import { baseOf, dirOf, foldersOf, isUnder, rewritePathPrefix } from "./logic/path-tree";
import { EDIT_SETTLE_MS } from "./logic/settle";
import { SyntaxThemePreference, parseSyntaxThemePreference } from "./logic/syntax-theme";
import {
	CODE_FILE_ENTITY_TYPE,
	type CodeEditorRuntime,
	type VaultSnapshot,
	getCodeEditorRuntime,
} from "./runtime";
import { CODE_EDITOR_CHORDS, CodeEditorAction } from "./shortcuts";
import { getYDocResolverApi } from "./store/ydoc-resolver";
import { LANGUAGES, LanguageKey } from "./types/code-file";
import { CodePaneHost, type CodePaneHostHandle } from "./ui/code-pane-host";
import { type CommandPaletteController, openCommandPalette } from "./ui/command-palette";
import { type DiagnosticsListHandle, createDiagnosticsList } from "./ui/diagnostics-list";
import { type DiffViewController, DiffViewMode, openDiffView } from "./ui/diff-view";
import { EntityIcon } from "./ui/entity-icon";
import { FileTree } from "./ui/file-tree";
import { codeFileObjectMenuContext } from "./ui/object-menu-context";
import { type QuickOpenController, openQuickOpen } from "./ui/quick-open";
import { NameMode, openRenamePopover } from "./ui/rename-popover";
import { useSettledValue } from "./use-settled-value";

const EMPTY_CITATION_INDEX: CitationIndex = new Map();

/** Widening adapter — the generic diagnostics list takes a `(string) =>
 *  string` translator; the app's `t` has a narrower literal-key domain. */
const translateMsg = (key: string, params?: Record<string, string>): string =>
	t(key as CodeEditorMessageKey, params);

/** Same widening for the catalog-bound `plural` helper, so the diagnostics
 *  builder can pluralise without knowing the app's key union. */
const pluralMsg = (
	count: number,
	oneKey: string,
	otherKey: string,
	params?: Record<string, string>,
): string =>
	appPlural(count, oneKey as CodeEditorMessageKey, otherKey as CodeEditorMessageKey, params);

// ── Panel + editor preferences (device-local; same localStorage path as
// every other first-party app). The right-hand refs panel is the exception:
// window-scoped via `@brainstorm-os/sdk/panel-state`. ──────────────────────
const NAV_OPEN_KEY = "code-editor:nav-open";
const REFS_OPEN_KEY = "code-editor:refs-open";
const WRAP_KEY = "code-editor:wrap";
const FORMAT_ON_SAVE_KEY = "code-editor:format-on-save";
const SYNTAX_THEME_KEY = "code-editor:syntax-theme";
const DIFF_MODE_KEY = "code-editor:diff-mode";
/** Collapsed folder prefixes + the UI-only folders that hold no file yet
 *  (9.7.12). Both are device-local view state on a device-local surface, so
 *  they ride the same `localStorage` idiom as the panel prefs above rather
 *  than minting vault entities — a folder here IS a path prefix, and an empty
 *  one has no path to live in until a file lands in it. */
const COLLAPSED_FOLDERS_KEY = "code-editor:collapsed-folders";
const PENDING_FOLDERS_KEY = "code-editor:pending-folders";
/** Bound on the persisted path lists so a pathological vault (or a wedged
 *  create loop) can't grow `localStorage` without limit. */
const MAX_PERSISTED_FOLDERS = 500;

function readFolderList(key: string): string[] {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((v): v is string => typeof v === "string").slice(0, MAX_PERSISTED_FOLDERS);
	} catch {
		return [];
	}
}

function writeFolderList(key: string, paths: readonly string[]): void {
	try {
		localStorage.setItem(key, JSON.stringify(paths.slice(0, MAX_PERSISTED_FOLDERS)));
	} catch {
		/* private mode / quota — ok */
	}
}

function readPanelPref(key: string, fallback: boolean): boolean {
	try {
		const raw = localStorage.getItem(key);
		return raw === null ? fallback : raw === "true";
	} catch {
		return fallback;
	}
}

function writePanelPref(key: string, open: boolean): void {
	try {
		localStorage.setItem(key, String(open));
	} catch {
		/* private mode / quota — ok */
	}
}

function readSyntaxThemePref(): SyntaxThemePreference {
	try {
		return parseSyntaxThemePreference(localStorage.getItem(SYNTAX_THEME_KEY));
	} catch {
		return SyntaxThemePreference.Auto;
	}
}

function writeSyntaxThemePref(preference: SyntaxThemePreference): void {
	try {
		localStorage.setItem(SYNTAX_THEME_KEY, preference);
	} catch {
		/* private mode / quota — ok */
	}
}

function readDiffModePref(): DiffViewMode {
	try {
		return localStorage.getItem(DIFF_MODE_KEY) === DiffViewMode.Unified
			? DiffViewMode.Unified
			: DiffViewMode.SideBySide;
	} catch {
		return DiffViewMode.SideBySide;
	}
}

function writeDiffModePref(mode: DiffViewMode): void {
	try {
		localStorage.setItem(DIFF_MODE_KEY, mode);
	} catch {
		/* private mode / quota — ok */
	}
}

function syntaxThemeLabelKey(preference: SyntaxThemePreference): CodeEditorMessageKey {
	switch (preference) {
		case SyntaxThemePreference.Light:
			return "syntaxTheme.light";
		case SyntaxThemePreference.Dark:
			return "syntaxTheme.dark";
		default:
			return "syntaxTheme.auto";
	}
}

function diffModeLabelKey(mode: DiffViewMode): CodeEditorMessageKey {
	return mode === DiffViewMode.Unified ? "diff.modeUnified" : "diff.modeSideBySide";
}

/** The header language control's options. The label is the human name from
 *  `languageLabel`; the value IS the persisted `LanguageKey`. Built once —
 *  the set is frozen at module scope. */
const LANGUAGE_OPTIONS = LANGUAGES.map((language) => ({
	value: language,
	label: languageLabel(language),
}));

/** The inline message a refused folder operation shows in the rename
 *  popover. Module-scope so it isn't re-minted per render (and so the mapping
 *  lives beside the enum it switches on). */
function folderErrorMessage(reason: RenameError): string {
	switch (reason) {
		case RenameError.Empty:
			return t("renameErrorEmpty");
		case RenameError.Locked:
			return t("folderErrorLocked");
		case RenameError.Cycle:
			return t("folderErrorCycle");
		default:
			return t("renameErrorDuplicate");
	}
}

const KIND_LABEL: Readonly<Record<CitationKind, () => string>> = {
	[CitationKind.Iteration]: () => t("kindIteration"),
	[CitationKind.OpenQuestion]: () => t("kindOpenQuestion"),
};

/** A row's live in-buffer content (edited value if dirty, else the saved
 *  property-bag content). */
function contentOf(row: CodeFileRow, edits: ReadonlyMap<string, string>): string {
	return edits.get(row.id) ?? row.content;
}

function isDirty(row: CodeFileRow, edits: ReadonlyMap<string, string>): boolean {
	const edited = edits.get(row.id);
	return edited !== undefined && edited !== row.content;
}

/** The diagnostics problem list (imperative builder) mounted via ref so the
 *  pure DOM module is reused unchanged inside the React inspector. The handle
 *  is created once and reconciles in place — mounting a freshly built subtree
 *  per update is what made the panel blink. `content` arrives already
 *  quiet-period-coalesced, so `update` runs once per typing pause, not per
 *  keystroke. */
function DiagnosticsList({
	content,
	language,
	onReveal,
}: {
	content: string;
	language: LanguageKey;
	onReveal: (line: number) => void;
}): ReactElement {
	const ref = useRef<HTMLDivElement>(null);
	const listRef = useRef<DiagnosticsListHandle | null>(null);
	// The reveal hook is read through a ref so a new callback identity can
	// never force the list to be rebuilt — the whole point of the handle.
	const onRevealRef = useRef(onReveal);
	onRevealRef.current = onReveal;
	useEffect(() => {
		const host = ref.current;
		if (!host) return;
		let list = listRef.current;
		if (!list) {
			list = createDiagnosticsList({
				t: translateMsg,
				plural: pluralMsg,
				onReveal: (line) => onRevealRef.current(line),
			});
			listRef.current = list;
			host.replaceChildren(list.element);
		}
		list.update(lintCode(content, language));
	}, [content, language]);
	return <div ref={ref} />;
}

export function CodeEditorApp(): ReactElement {
	// Re-render when the active locale changes; imperative + child surfaces read `t`.
	useCodeEditorT();
	const plural = useCodeEditorPlural();
	const runtime = useMemo(() => getCodeEditorRuntime(), []);
	const [ready, setReady] = useState(false);

	const [rows, setRows] = useState<CodeFileRow[]>([]);
	const [citationIndex, setCitationIndex] = useState<CitationIndex>(EMPTY_CITATION_INDEX);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [edits, setEdits] = useState<Map<string, string>>(() => new Map());

	const [navOpen, setNavOpen] = useState(() => readPanelPref(NAV_OPEN_KEY, true));
	const [refsOpen, setRefsOpen] = useState(() => readPanelOpen(REFS_OPEN_KEY, true));

	// ── Folder tree view state (9.7.12) ───────────────────────────────────────
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
		() => new Set(readFolderList(COLLAPSED_FOLDERS_KEY)),
	);
	const [pendingFolders, setPendingFolders] = useState<string[]>(() =>
		readFolderList(PENDING_FOLDERS_KEY),
	);
	// The folder a create lands in — published by the tree from its focused row
	// so the header "+" and the sidebar buttons agree on the target.
	const [focusFolder, setFocusFolder] = useState("");
	const focusFolderRef = useRef(focusFolder);
	focusFolderRef.current = focusFolder;
	const pendingFoldersRef = useRef(pendingFolders);
	pendingFoldersRef.current = pendingFolders;

	// Cross-app handoff target (theme-editor → "Edit in Code Editor"). The
	// StylePack id surfaces an adapted CSS row; `pendingOpenId` auto-selects
	// the target once it lands in `rows`.
	const [openStylePackId, setOpenStylePackId] = useState<string | null>(null);
	const pendingOpenIdRef = useRef<string | null>(null);
	const focusBufferOnOpenRef = useRef(false);

	const paneRef = useRef<CodePaneHostHandle | null>(null);
	const rootRef = useRef<HTMLElement>(null);
	const quickOpenRef = useRef<QuickOpenController | null>(null);
	const commandPaletteRef = useRef<CommandPaletteController | null>(null);
	const diffViewRef = useRef<DiffViewController | null>(null);

	const nav = useMemo(() => createNavHistory<string>({ initial: "" }), []);

	// Latest rows/edits/selection in refs so the imperative pane callbacks +
	// save/rename/delete paths read current values without re-binding.
	const rowsRef = useRef(rows);
	rowsRef.current = rows;
	const editsRef = useRef(edits);
	editsRef.current = edits;
	const selectedIdRef = useRef(selectedId);
	selectedIdRef.current = selectedId;

	// ── Live vault snapshot through the ONE shared reactivity stack —
	// `useVaultEntities` owns the change subscription + trailing-coalesce +
	// first load (per the app-reactivity rule; the app never touches
	// `onChange` itself). In standalone-dev (no runtime) the demo dataset
	// stands in. The runtime's service shape is structurally the sdk-types
	// `VaultEntitiesService` (its `onChange` is the only optional delta). ─────
	const hasRuntimeVault = Boolean(runtime?.services?.vaultEntities);
	const vaultService =
		ready && runtime?.services?.vaultEntities
			? (runtime.services.vaultEntities as unknown as VaultEntitiesService)
			: null;
	const liveSnapshot = useVaultEntities(vaultService, {
		onError: (error) => console.warn("[code-editor] vault list failed:", error),
	});
	const snapshot = liveSnapshot as unknown as VaultSnapshot;

	const selectFile = useCallback(
		(id: string): void => {
			if (!id || id === selectedIdRef.current) return;
			// The diff overlay reviews a specific file's changes — drop it.
			diffViewRef.current?.close();
			if (nav.current() === "") nav.replace(id);
			else nav.push(id);
			setSelectedId(id);
			// Remember the open file so the next plain launch lands back on it
			// (device-local, per-vault, app-namespaced — see `@brainstorm-os/sdk/last-viewed`).
			void rememberLastViewed(getCodeEditorRuntime()?.services?.settings, id);
		},
		[nav],
	);

	const applyFileLoc = useCallback((id: string): void => {
		setSelectedId(id || null);
	}, []);

	// ── Boot: honour an open-entity launch (cross-app handoff target), then
	// mark ready so the live vault list binds. Mirrors theme-editor's ready
	// handshake (the runtime hands services over after first paint). ─────────
	useEffect(() => {
		let cancelled = false;
		const finish = (): void => {
			if (!cancelled) setReady(true);
		};
		const launch = runtime?.launch;
		if (launch?.reason === "open-entity" && launch.entityId) {
			setOpenStylePackId(launch.entityId);
			pendingOpenIdRef.current = launch.entityId;
		}
		// Reopen the file the user was last editing on a plain launch. The recall
		// resolves before we flip `ready` (which binds the live vault list), so
		// `pendingOpenIdRef` is populated before the first rows arrive and the
		// auto-select effect honours it; a since-deleted file simply never matches.
		// `recallLastViewed` never rejects, so `finally` always reaches `finish`.
		const settings = runtime?.services?.settings;
		const restore =
			launch?.reason !== "open-entity" && settings
				? recallLastViewed(settings).then((id) => {
						if (id && !pendingOpenIdRef.current) pendingOpenIdRef.current = id;
					})
				: Promise.resolve();
		const start = (): void => void restore.finally(finish);
		if (runtime?.on) {
			runtime.on("ready", start);
		} else {
			start();
		}
		return () => {
			cancelled = true;
		};
	}, [runtime]);

	// ── Project the live snapshot into rows + the citation index. Demo data
	// stands in when there's no vault service (standalone-dev). The
	// `useVaultEntities` store already owns the change subscription. ──────────
	useEffect(() => {
		if (!hasRuntimeVault) {
			setCitationIndex(buildDemoCitationIndex());
			setRows(buildCodeDemo());
			return;
		}
		setCitationIndex(buildCitationIndex(snapshot));
		setRows(projectCodeFiles(snapshot, openStylePackId));
	}, [hasRuntimeVault, snapshot, openStylePackId]);

	// Drop in-memory edits whose file vanished from the vault.
	useEffect(() => {
		setEdits((prev) => {
			let changed = false;
			const next = new Map(prev);
			for (const id of prev.keys()) {
				if (!rows.some((r) => r.id === id)) {
					next.delete(id);
					changed = true;
				}
			}
			return changed ? next : prev;
		});
	}, [rows]);

	// Auto-select the cross-app handoff target / last-viewed once present, else
	// keep the default first-row selection valid.
	useEffect(() => {
		if (rows.length === 0) {
			if (selectedId !== null) setSelectedId(null);
			return;
		}
		const pending = pendingOpenIdRef.current;
		if (pending && rows.some((r) => r.id === pending)) {
			pendingOpenIdRef.current = null;
			selectFile(pending);
			const renameTarget = pendingRenameIdRef.current;
			if (renameTarget === pending) {
				// Fresh create (F-451): arm the inline rename on the new row instead
				// of focusing the buffer — naming beats another immortal untitled-N.
				pendingRenameIdRef.current = null;
				focusBufferOnOpenRef.current = false;
				const row = rows.find((r) => r.id === pending);
				if (row) requestAnimationFrame(() => renameFileRef.current?.(row, NameMode.Create));
				return;
			}
			if (focusBufferOnOpenRef.current) {
				focusBufferOnOpenRef.current = false;
				requestAnimationFrame(() => paneRef.current?.focus());
			}
			return;
		}
		if (selectedId === null || !rows.some((r) => r.id === selectedId)) {
			setSelectedId(rows[0]?.id ?? null);
		}
	}, [rows, selectedId, selectFile]);

	// Live `open` push while already running (the launcher focuses the existing
	// window, so `launch` doesn't update — `app:intent` re-delivers).
	useEffect(() => {
		const sub = runtime?.on?.("intent", (event) => {
			if (event.type !== "intent" || event.intent.verb !== "open") return;
			const entityId = event.intent.payload?.entityId;
			if (typeof entityId !== "string" || !entityId) return;
			setOpenStylePackId(entityId);
			pendingOpenIdRef.current = entityId;
		});
		return () => sub?.unsubscribe?.();
	}, [runtime]);

	const selectedRow = useMemo(
		() => rows.find((r) => r.id === selectedId) ?? null,
		[rows, selectedId],
	);
	// PRES-3 — who's-here on the open code file (cross-device in the shell).
	const filePeers = usePresence(selectedRow?.id ?? null, CODE_FILE_ENTITY_TYPE, useSelf());

	const canCreateFile = Boolean(runtime?.services?.entities?.create);

	// ── Header / tab identity ────────────────────────────────────────────────
	useEffect(() => {
		publishTabIdentity({
			title: selectedRow ? fileName(selectedRow.path) : t("appTitle"),
			icon: selectedRow?.icon ?? null,
		});
	}, [selectedRow]);

	// ── Edits + persistence ──────────────────────────────────────────────────
	const onContentChange = useCallback((id: string, content: string) => {
		setEdits((prev) => {
			const next = new Map(prev);
			const row = rowsRef.current.find((r) => r.id === id);
			if (row && content === row.content) next.delete(id);
			else next.set(id, content);
			return next;
		});
	}, []);

	const persistSelected = useCallback(async (): Promise<void> => {
		const row = rowsRef.current.find((r) => r.id === selectedIdRef.current);
		if (!row) return;
		if (readPanelPref(FORMAT_ON_SAVE_KEY, false) && paneRef.current?.canFormatBuffer()) {
			await paneRef.current.formatBuffer();
		}
		const content = editsRef.current.get(row.id);
		if (content === undefined || content === row.content) return;
		const update = getCodeEditorRuntime()?.services?.entities?.update;
		if (!update) {
			console.info(
				"[code-editor] save: no entities.update surface; Y.Doc transport still persists the body",
			);
			return;
		}
		try {
			await update(row.id, { [row.contentKey]: content });
			setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, content } : r)));
			setEdits((prev) => {
				const next = new Map(prev);
				next.delete(row.id);
				return next;
			});
			// The saved content is the new diff baseline — repaint so the gutter
			// change markers clear for the now-persisted lines.
			paneRef.current?.refresh();
		} catch (error) {
			console.warn("[code-editor] save failed:", error);
		}
	}, []);

	const createNewFile = useCallback(async (folder?: string): Promise<void> => {
		const create = getCodeEditorRuntime()?.services?.entities?.create;
		if (!create) return;
		const target = folder ?? focusFolderRef.current;
		const path = nextUntitledPath(
			rowsRef.current.map((r) => r.path),
			target,
		);
		try {
			const created = await create(CODE_FILE_ENTITY_TYPE, {
				path,
				content: "",
				language: LanguageKey.TypeScript,
			});
			if (created?.id) {
				pendingOpenIdRef.current = created.id;
				focusBufferOnOpenRef.current = true;
				// Creation invites a name — arm the existing inline rename for the
				// new row once it renders; an untitled-N should be the fallback,
				// not the destiny (F-451, Marcus session 910).
				pendingRenameIdRef.current = created.id;
			}
		} catch (error) {
			console.warn("[code-editor] new file failed:", error);
		}
	}, []);

	const applyRename = useCallback(async (row: CodeFileRow, path: string): Promise<void> => {
		const update = getCodeEditorRuntime()?.services?.entities?.update;
		if (!update) return;
		// A rename that changes the extension changes what the file IS — re-derive
		// and PERSIST the language so highlighting, the header chip and the
		// diagnostics rail all follow the new name (POLISH-FN-2). The stored
		// property is the source of truth every reader (Preview, the agent's code
		// preview, the projector) trusts, so a stale value has to be corrected at
		// the write, not papered over per reader.
		const language = languageAfterRename(
			row.language,
			path,
			editsRef.current.get(row.id)?.split("\n", 1)[0] ?? row.content.split("\n", 1)[0] ?? "",
		);
		try {
			await update(row.id, language === row.language ? { path } : { path, language });
			setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, path, language } : r)));
		} catch (err) {
			console.warn("[code-editor] rename failed:", err);
		}
	}, []);

	// ── Folder operations (9.7.12) ────────────────────────────────────────────
	// A folder IS a path prefix, so every folder write is N file-path writes.
	// The plan is computed first (collisions / locks / cycles), then applied —
	// so one user action either lands whole or is refused whole.

	/** The files as the planners see them: id + path + rewritable-or-not. EVERY
	 *  row is included so the collision set is complete; a row that must not be
	 *  rewritten — read-only-locked, or an adapted StylePack whose path is
	 *  synthesized from its name rather than stored — is marked `locked`, which
	 *  is exactly the flag the planners refuse on. */
	const planFiles = useCallback(
		(): FolderPlanFile[] =>
			rowsRef.current.map((row) => ({
				id: row.id,
				path: row.path,
				locked: !isCodeFileEditable(row),
			})),
		[],
	);

	const applyMoves = useCallback(async (moves: readonly PathMove[]): Promise<void> => {
		const update = getCodeEditorRuntime()?.services?.entities?.update;
		if (!update || moves.length === 0) return;
		const landed: PathMove[] = [];
		for (const move of moves) {
			try {
				await update(move.id, { path: move.to });
				landed.push(move);
			} catch (err) {
				console.warn("[code-editor] move failed:", err);
			}
		}
		if (landed.length === 0) return;
		const byId = new Map(landed.map((move) => [move.id, move.to]));
		setRows((prev) =>
			prev.map((r) => (byId.has(r.id) ? { ...r, path: byId.get(r.id) ?? r.path } : r)),
		);
	}, []);

	/** Carry the pending (file-less) folders through a prefix rewrite, and drop
	 *  the ones a file now occupies — a folder that exists in the paths needs no
	 *  UI-only stand-in. */
	const reconcilePendingFolders = useCallback((from: string, to: string): void => {
		setPendingFolders((prev) => {
			const rewritten = prev.map((folder) =>
				folder.toLowerCase() === from.toLowerCase() ? to : rewritePathPrefix(folder, from, to),
			);
			return [...new Set(rewritten)].slice(0, MAX_PERSISTED_FOLDERS);
		});
	}, []);

	const runFolderPlan = useCallback(
		async (plan: FolderPlan, from: string): Promise<void> => {
			if (!plan.ok) return;
			reconcilePendingFolders(from, plan.path);
			setCollapsed((prev) => {
				const next = new Set<string>();
				for (const folder of prev) {
					next.add(
						folder.toLowerCase() === from.toLowerCase()
							? plan.path
							: rewritePathPrefix(folder, from, plan.path),
					);
				}
				return next;
			});
			await applyMoves(plan.moves);
		},
		[applyMoves, reconcilePendingFolders],
	);

	const createFolder = useCallback((parent: string): void => {
		// Computed outside the state updater: an updater must stay pure (React
		// may invoke it twice), and arming the rename is a side effect.
		const existing = foldersOf(rowsRef.current.map((r) => r.path));
		const path = nextFolderPath([...existing, ...pendingFoldersRef.current], parent);
		pendingFolderRenameRef.current = path;
		setPendingFolders((prev) =>
			prev.includes(path) ? prev : [...prev, path].slice(0, MAX_PERSISTED_FOLDERS),
		);
	}, []);

	const removeFolder = useCallback((path: string): void => {
		// Only ever reachable for a folder with no file beneath it (the tree
		// gates the affordance), so this is pure local view state — no writes.
		setPendingFolders((prev) => prev.filter((folder) => folder !== path && !isUnder(folder, path)));
	}, []);

	const toggleFolder = useCallback((path: string): void => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (!next.delete(path)) next.add(path);
			return next;
		});
	}, []);

	const pendingFolderRenameRef = useRef<string | null>(null);
	const renameFolderRef = useRef<((path: string, mode?: NameMode) => void) | null>(null);

	const renameFolder = useCallback(
		(path: string, mode: NameMode = NameMode.Rename): void => {
			if (!getCodeEditorRuntime()?.services?.entities?.update) return;
			const creating = mode === NameMode.Create;
			openRenamePopover({
				title: creating ? t("newFolder") : t("folderRenameTitle", { name: baseOf(path) }),
				value: path,
				inputLabel: t("folderRenameLabel"),
				cancelLabel: t("renameCancel"),
				saveLabel: creating ? t("renameCreate") : t("renameSave"),
				testId: "code-folder-rename",
				submit: (typed) => {
					const plan = planFolderRename(typed, path, planFiles(), pendingFoldersRef.current);
					if (!plan.ok) return folderErrorMessage(plan.reason);
					void runFolderPlan(plan, path);
					return null;
				},
			});
		},
		[planFiles, runFolderPlan],
	);
	renameFolderRef.current = renameFolder;

	const moveFiles = useCallback(
		(entityIds: readonly string[], folder: string): void => {
			const moves: PathMove[] = [];
			// Each plan is judged against the paths as the PREVIOUS moves in this
			// drop already left them, so two same-named files dropped together
			// can't both claim the destination path.
			let files = planFiles();
			for (const id of entityIds) {
				const file = files.find((f) => f.id === id);
				if (!file) continue;
				const plan = planFileMove(file, folder, files);
				if (!plan?.ok) continue;
				moves.push(...plan.moves);
				files = files.map((f) => (f.id === file.id ? { ...f, path: plan.path } : f));
			}
			void applyMoves(moves);
		},
		[planFiles, applyMoves],
	);

	const moveFolder = useCallback(
		(path: string, dest: string): void => {
			const plan = planFolderMove(path, dest, planFiles(), pendingFoldersRef.current);
			if (plan.ok) void runFolderPlan(plan, path);
		},
		[planFiles, runFolderPlan],
	);

	const toggleFileLock = useCallback((): void => {
		const row = selectedRow;
		if (!row) return;
		const update = getCodeEditorRuntime()?.services?.entities?.update;
		if (!update) return;
		void update(row.id, { locked: !row.locked });
	}, [selectedRow]);

	/** Override the detected language from the header select. Persisted, because
	 *  the stored property is what every reader (Preview, the agent's code
	 *  preview, the projector) trusts. Refused on a locked / adapted row — the
	 *  control is disabled there too, this is the write-path half of the gate. */
	const setFileLanguage = useCallback(
		(language: LanguageKey): void => {
			const row = selectedRow;
			if (!row || !isCodeFileEditable(row) || language === row.language) return;
			const update = getCodeEditorRuntime()?.services?.entities?.update;
			if (!update) return;
			void (async () => {
				try {
					await update(row.id, { language });
					setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, language } : r)));
				} catch (err) {
					console.warn("[code-editor] language change failed:", err);
				}
			})();
		},
		[selectedRow],
	);

	const pendingRenameIdRef = useRef<string | null>(null);
	const renameFileRef = useRef<((row: CodeFileRow, mode?: NameMode) => void) | null>(null);

	const renameFile = useCallback(
		(row: CodeFileRow, mode: NameMode = NameMode.Rename): void => {
			if (row.locked) return;
			if (!getCodeEditorRuntime()?.services?.entities?.update) return;
			const dot = row.path.lastIndexOf(".");
			const creating = mode === NameMode.Create;
			openRenamePopover({
				title: creating ? t("command.newFile") : t("renameTitle", { name: fileName(row.path) }),
				value: row.path,
				inputLabel: t("renameLabel"),
				cancelLabel: t("renameCancel"),
				saveLabel: creating ? t("renameCreate") : t("renameSave"),
				testId: "code-rename",
				selectTo: dot > 0 ? dot : row.path.length,
				submit: (typed) => {
					const result = validateRenamePath(
						typed,
						row.path,
						rowsRef.current.map((r) => r.path),
					);
					if (!result.ok) {
						return result.reason === RenameError.Empty
							? t("renameErrorEmpty")
							: t("renameErrorDuplicate");
					}
					void applyRename(row, result.path);
					return null;
				},
			});
		},
		[applyRename],
	);
	renameFileRef.current = renameFile;

	const deleteFile = useCallback(async (row: CodeFileRow): Promise<void> => {
		if (row.locked) return;
		const del = getCodeEditorRuntime()?.services?.entities?.delete;
		if (!del) return;
		try {
			await del(row.id);
			setEdits((prev) => {
				const next = new Map(prev);
				next.delete(row.id);
				return next;
			});
			setRows((prev) => prev.filter((r) => r.id !== row.id));
		} catch (err) {
			console.warn("[code-editor] delete failed:", err);
		}
	}, []);

	const confirmDeleteFile = useCallback(
		(row: CodeFileRow): void => {
			const del = getCodeEditorRuntime()?.services?.entities?.delete;
			if (!del) return;
			const name = fileName(row.path);

			const actions = document.createElement("div");
			actions.className = "editor__rename-actions";
			const cancelBtn = document.createElement("button");
			cancelBtn.type = "button";
			cancelBtn.className = "bs-btn bs-btn--ghost";
			cancelBtn.textContent = t("deleteCancel");
			const confirmBtn = document.createElement("button");
			confirmBtn.type = "button";
			confirmBtn.className = "bs-btn bs-btn--danger";
			confirmBtn.textContent = t("deleteConfirm");
			actions.append(cancelBtn, confirmBtn);

			const handle = createPopoverElement({
				title: t("deleteTitle", { name }),
				body: t("deleteBody", { name }),
				footer: actions,
				size: PopoverSize.Small,
				testId: "code-delete",
				onClose: () => handle.close(),
			});
			cancelBtn.addEventListener("click", () => handle.close());
			confirmBtn.addEventListener("click", () => {
				handle.close();
				void deleteFile(row);
			});
			confirmBtn.focus();
		},
		[deleteFile],
	);

	const fileMenuContext = useCallback(
		(row: CodeFileRow) => {
			const rt = getCodeEditorRuntime();
			const entities = rt?.services?.entities;
			// A locked file is read-only — rename/delete drop out of its object
			// menu (the text pane already freezes via `CodePaneHost locked`).
			const editable = isCodeFileEditable(row);
			return codeFileObjectMenuContext(row, rt, {
				...(editable && entities?.update ? { onRename: () => renameFile(row) } : {}),
				...(editable && entities?.delete ? { onDelete: () => confirmDeleteFile(row) } : {}),
			});
		},
		[renameFile, confirmDeleteFile],
	);

	// ── Row open (plain = in-place select; Cmd/Shift/middle = shell intent) ──
	const openRow = useCallback(
		(row: CodeFileRow, mode: NavigationMode): void => {
			if (mode === NavigationMode.Replace) {
				selectFile(row.id);
				return;
			}
			void openEntity(getCodeEditorRuntime(), {
				entityId: row.id,
				entityType: CODE_FILE_ENTITY_TYPE,
				mode,
			}).then((dispatched) => {
				if (!dispatched) selectFile(row.id);
			});
		},
		[selectFile],
	);

	// ── Keyboard navigation between files (wrapping). ────────────────────────
	const moveSelection = useCallback(
		(delta: number): void => {
			const list = rowsRef.current;
			if (list.length < 2) return;
			const idx = list.findIndex((r) => r.id === selectedIdRef.current);
			const base = idx < 0 ? 0 : idx;
			const next = (base + delta + list.length) % list.length;
			const target = list[next];
			if (target) selectFile(target.id);
		},
		[selectFile],
	);

	const focusReferences = useCallback((): void => {
		const root = rootRef.current;
		const firstRef = root?.querySelector<HTMLElement>(".editor__ref");
		if (firstRef) {
			firstRef.focus();
			return;
		}
		root?.querySelector<HTMLElement>(".editor__refs")?.focus();
	}, []);

	const revealLine = useCallback((line: number): void => {
		paneRef.current?.revealLine(line);
	}, []);

	// ── Overlays (quick-open / command palette / diff) — imperative
	// controllers mounted into the editor root. ─────────────────────────────
	const showQuickOpen = useCallback((): void => {
		if (quickOpenRef.current) return;
		const mount = rootRef.current ?? document.body;
		quickOpenRef.current = openQuickOpen({
			rows: rowsRef.current,
			mount,
			onChoose: (id) => selectFile(id),
			onClose: () => {
				quickOpenRef.current = null;
			},
		});
	}, [selectFile]);

	const buildCommands = useCallback((): EditorCommand[] => {
		const commands: EditorCommand[] = [];
		const pane = paneRef.current;
		commands.push({
			id: CodeEditorAction.QuickOpen,
			label: t("command.quickOpen"),
			keywords: ["file", "jump", "open", "goto", "find file"],
			run: () => showQuickOpen(),
		});
		commands.push({
			id: CodeEditorAction.Save,
			label: t("command.save"),
			keywords: ["write", "persist"],
			run: () => void persistSelected(),
		});
		if (canCreateFile) {
			commands.push({
				id: "code-editor.new-file",
				label: t("command.newFile"),
				keywords: ["create", "add", "untitled"],
				run: () => void createNewFile(),
			});
		}
		if (pane) {
			commands.push(
				{
					id: "code-editor.find",
					label: t("command.find"),
					keywords: ["search", "find", "buffer"],
					run: () => pane.openFind("find"),
				},
				{
					id: "code-editor.replace",
					label: t("command.replace"),
					keywords: ["search", "replace", "substitute"],
					run: () => pane.openFind("find-replace"),
				},
				{
					id: CodeEditorAction.FoldAtCaret,
					label: t("command.fold"),
					keywords: ["fold", "collapse", "region"],
					run: () => pane.foldAtCaret(),
				},
				{
					id: CodeEditorAction.UnfoldAtCaret,
					label: t("command.unfold"),
					keywords: ["unfold", "expand", "region"],
					run: () => pane.unfoldAtCaret(),
				},
				{
					id: CodeEditorAction.UnfoldAll,
					label: t("command.unfoldAll"),
					keywords: ["unfold", "expand", "all"],
					run: () => pane.unfoldAll(),
				},
			);
			if (pane.canFormatBuffer()) {
				commands.push({
					id: CodeEditorAction.FormatDocument,
					label: t("command.formatDocument"),
					keywords: ["prettier", "format", "beautify", "indent"],
					run: () => void pane.formatBuffer(),
				});
			}
		}
		commands.push(
			{
				id: CodeEditorAction.FocusReferences,
				label: t("command.focusReferences"),
				keywords: ["references", "citations", "plan"],
				run: () => focusReferences(),
			},
			{
				id: "code-editor.toggle-wrap",
				label: t("command.toggleWrap"),
				keywords: ["word wrap", "lines"],
				run: () => paneRef.current?.toggleWrap(),
			},
			{
				id: "code-editor.toggle-files",
				label: t("command.toggleFiles"),
				keywords: ["sidebar", "panel", "explorer"],
				run: () => setNavOpen((v) => !v),
			},
			{
				id: "code-editor.toggle-references",
				label: t("command.toggleReferences"),
				keywords: ["sidebar", "panel", "inspector"],
				run: () => setRefsOpen((v) => !v),
			},
		);
		return commands;
	}, [canCreateFile, showQuickOpen, persistSelected, createNewFile, focusReferences]);

	const showCommandPalette = useCallback((): void => {
		if (commandPaletteRef.current) return;
		const mount = rootRef.current ?? document.body;
		commandPaletteRef.current = openCommandPalette({
			commands: buildCommands(),
			mount,
			onClose: () => {
				commandPaletteRef.current = null;
			},
		});
	}, [buildCommands]);

	const showDiff = useCallback(
		(params: { baseline: string; current: string; mode: DiffViewMode }): void => {
			const row = rowsRef.current.find((r) => r.id === selectedIdRef.current);
			diffViewRef.current?.close();
			diffViewRef.current = openDiffView({
				fileName: row ? fileName(row.path) : "",
				baseline: params.baseline,
				current: params.current,
				mode: params.mode,
				mount: rootRef.current ?? document.body,
				labels: {
					title: (name) => t("diff.title", { name }),
					close: t("diff.close"),
					stats: ({ added, removed }) => t("diff.stats", { added, removed }),
					noChanges: t("diff.noChanges"),
					baseColumn: t("diff.baseColumn"),
					nextColumn: t("diff.nextColumn"),
				},
				onClose: () => {
					diffViewRef.current = null;
				},
			});
		},
		[],
	);

	// ── Persist panel prefs + folder view state ──────────────────────────────
	useEffect(() => writePanelPref(NAV_OPEN_KEY, navOpen), [navOpen]);
	useEffect(() => writePanelOpen(REFS_OPEN_KEY, refsOpen), [refsOpen]);
	useEffect(() => writeFolderList(COLLAPSED_FOLDERS_KEY, [...collapsed]), [collapsed]);
	useEffect(() => writeFolderList(PENDING_FOLDERS_KEY, pendingFolders), [pendingFolders]);

	// A pending folder is a stand-in for a folder no path implies yet; once a
	// file lands in it the prefix is real and the stand-in retires. Keeping
	// both would leave a duplicate claim on the same row.
	useEffect(() => {
		const real = new Set(foldersOf(rows.map((r) => r.path)).map((f) => f.toLowerCase()));
		setPendingFolders((prev) => {
			const next = prev.filter((folder) => !real.has(folder.toLowerCase()));
			return next.length === prev.length ? prev : next;
		});
	}, [rows]);

	// A freshly created folder invites a name — arm the rename the moment its
	// row exists, mirroring what a new FILE does (F-451).
	useEffect(() => {
		const target = pendingFolderRenameRef.current;
		if (target === null || !pendingFolders.includes(target)) return;
		pendingFolderRenameRef.current = null;
		requestAnimationFrame(() => renameFolderRef.current?.(target, NameMode.Create));
	}, [pendingFolders]);

	// ── Window-level chords routed through the shared shortcut registry. ─────
	useEffect(() => {
		const disposers: ShortcutDisposer[] = [
			attachShortcut(window, CODE_EDITOR_CHORDS[CodeEditorAction.Save], () => {
				void persistSelected();
			}),
			attachShortcut(window, CODE_EDITOR_CHORDS[CodeEditorAction.FilePrev], () => moveSelection(-1)),
			attachShortcut(window, CODE_EDITOR_CHORDS[CodeEditorAction.FileNext], () => moveSelection(1)),
			attachShortcut(window, CODE_EDITOR_CHORDS[CodeEditorAction.FocusReferences], () =>
				focusReferences(),
			),
			attachShortcut(window, CODE_EDITOR_CHORDS[CodeEditorAction.QuickOpen], () => showQuickOpen()),
			attachShortcut(window, CODE_EDITOR_CHORDS[CodeEditorAction.CommandPalette], () =>
				showCommandPalette(),
			),
			attachShortcut(window, CODE_EDITOR_CHORDS[CodeEditorAction.FormatDocument], () => {
				void paneRef.current?.formatBuffer();
			}),
		];
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, [persistSelected, moveSelection, focusReferences, showQuickOpen, showCommandPalette]);

	const selectedContent = selectedRow ? contentOf(selectedRow, edits) : "";
	// `edits` changes on every keystroke, so deriving the inspector straight off
	// it re-scanned the whole buffer per character and rebuilt the panel with
	// it. The inspector reads a quiet-period-coalesced copy instead: during a
	// burst the previously derived content stays on screen (no mid-typing flash
	// to the empty state), and it catches up the moment typing pauses. A file
	// switch flushes immediately — the other file's references aren't "late",
	// they're wrong.
	const settledContent = useSettledValue(selectedContent, EDIT_SETTLE_MS, selectedRow?.id ?? null);

	const refs = useMemo(
		() => collectReferences(settledContent, citationIndex),
		[settledContent, citationIndex],
	);

	const totalFiles = rows.length;
	const dirtyIds = useMemo(
		() => new Set(rows.filter((r) => isDirty(r, edits)).map((r) => r.id)),
		[rows, edits],
	);
	const dirtyCount = dirtyIds.size;

	const metaText =
		totalFiles === 0
			? ""
			: dirtyCount > 0
				? plural(totalFiles, "metaUnsavedOne", "metaUnsaved", { dirty: dirtyCount })
				: plural(totalFiles, "metaFilesOne", "metaFilesMany");

	// The header ⋯ is the ONE menu now (the pane no longer draws its own
	// header bar): prefer the pane's rich context (file actions + editor
	// toggles — diff layout, wrap, format-on-save, syntax theme), falling
	// back to the plain file menu before the pane has mounted.
	const headerMenuContext = useCallback(
		() => paneRef.current?.menuContext() ?? (selectedRow ? fileMenuContext(selectedRow) : null),
		[selectedRow, fileMenuContext],
	);

	return (
		<>
			<header className="app-header" data-testid="app-header">
				<div className="app-header__left" id="header-left">
					<NavButtons history={nav} onNavigate={applyFileLoc} />
					{selectedRow ? (
						<ObjectMenuTrigger
							context={headerMenuContext}
							moreActionsLabel={t("menuMoreActions", { name: fileName(selectedRow.path) })}
							noMoreButton
						>
							<button
								type="button"
								className="bs-icon-pick editor__header-icon"
								aria-label={t("fileIconSelect", { name: fileName(selectedRow.path) })}
								onClick={() => selectFile(selectedRow.id)}
							>
								<EntityIcon icon={selectedRow.icon} size={18} />
							</button>
							<span className="app-header__title" title={selectedRow.path}>
								{fileName(selectedRow.path)}
							</span>
						</ObjectMenuTrigger>
					) : (
						<span className="app-header__title">{t("appTitle")}</span>
					)}
				</div>
				<div className="app-header__right">
					{filePeers.length > 0 && <PresenceStack peers={filePeers} />}
					<div className="app-header__meta" id="header-meta">
						{metaText}
					</div>
					{selectedRow ? (
						<SelectMenu
							className="bs-select--sm editor__lang"
							value={selectedRow.language}
							options={LANGUAGE_OPTIONS}
							onChange={setFileLanguage}
							ariaLabel={t("languageSelect")}
							disabled={!isCodeFileEditable(selectedRow)}
							data-testid="code-language"
						/>
					) : null}
					{canCreateFile ? (
						<button
							type="button"
							className="bs-btn bs-btn--sm bs-btn--icon editor__header-new"
							data-bs-tooltip={t("newFileHint")}
							aria-label={t("newFileHint")}
							onClick={() => void createNewFile()}
						>
							<Icon name={IconName.Plus} size={15} />
						</button>
					) : null}
					<PanelToggleButton
						side={PanelSide.Left}
						open={navOpen}
						onClick={() => setNavOpen((v) => !v)}
						labels={{ show: t("navToggle.show"), hide: t("navToggle.hide") }}
					/>
					<PanelToggleButton
						side={PanelSide.Right}
						open={refsOpen && !!selectedRow}
						onClick={() => setRefsOpen((v) => !v)}
						labels={{ show: t("refsToggle.show"), hide: t("refsToggle.hide") }}
						disabled={!selectedRow}
						{...(selectedRow ? {} : { hint: t("refsToggle.disabled") })}
						testId="refs-toggle"
					/>
					{selectedRow ? (
						<LockButton
							locked={selectedRow.locked}
							onToggle={toggleFileLock}
							lockLabel={t("header.lock")}
							unlockLabel={t("header.unlock")}
						/>
					) : null}
					<ObjectMenuMoreButton
						context={headerMenuContext}
						moreActionsLabel={t("menuMoreActions", {
							name: selectedRow ? fileName(selectedRow.path) : t("appTitle"),
						})}
						disabled={!selectedRow}
					/>
				</div>
			</header>
			<main
				className="editor"
				ref={rootRef}
				data-nav-open={String(navOpen)}
				data-refs-open={String(refsOpen)}
			>
				{rows.length === 0 ? (
					<EmptyState
						className="editor__empty"
						icon={IconName.View}
						title={t("emptyTitle")}
						hint={t("emptySub")}
						action={
							canCreateFile ? (
								<button
									type="button"
									className="bs-btn editor__empty-new"
									data-bs-primary=""
									title={t("newFileHint")}
									onClick={() => void createNewFile()}
								>
									{t("emptyNewFile")}
								</button>
							) : undefined
						}
					/>
				) : (
					<>
						<FileTree
							rows={rows}
							selectedId={selectedId}
							dirtyIds={dirtyIds}
							collapsed={collapsed}
							pendingFolders={pendingFolders}
							canCreate={canCreateFile}
							onToggleFolder={toggleFolder}
							onFocusFolderChange={setFocusFolder}
							onOpen={openRow}
							onCreateFile={createNewFile}
							onCreateFolder={createFolder}
							onRenameFolder={renameFolder}
							onRemoveFolder={removeFolder}
							onMoveFiles={moveFiles}
							onMoveFolder={moveFolder}
							menuContext={fileMenuContext}
						/>
						{selectedRow ? (
							<CodePaneHost
								ref={paneRef}
								row={selectedRow}
								locked={selectedRow.locked}
								citationIndex={citationIndex}
								resolver={getYDocResolverApi}
								labels={{
									bufferLabel: (name) => t("bufferLabel", { name }),
									pathTitle: (path) => path,
									menuMoreActions: (name) => t("menuMoreActions", { name }),
									citationHover: {
										heading: (entry) =>
											entry.kind === CitationKind.Iteration ? t("kindIteration") : t("kindOpenQuestion"),
										close: t("citationHoverClose"),
										openAction: t("citationHoverOpen"),
									},
									wrapEnable: t("wrapEnable"),
									wrapDisable: t("wrapDisable"),
									syntaxThemeHeading: t("syntaxTheme.heading"),
									syntaxThemeOption: (pref) => t(syntaxThemeLabelKey(pref)),
									diffShow: t("diff.show"),
									diffModeHeading: t("diff.modeHeading"),
									diffModeOption: (mode) => t(diffModeLabelKey(mode)),
									formatOnSaveEnable: t("formatOnSave.enable"),
									formatOnSaveDisable: t("formatOnSave.disable"),
									completionListLabel: t("completion.listLabel"),
								}}
								wrap={readPanelPref(WRAP_KEY, false)}
								onWrapChange={(wrapped) => writePanelPref(WRAP_KEY, wrapped)}
								formatOnSave={readPanelPref(FORMAT_ON_SAVE_KEY, false)}
								onFormatOnSaveChange={(enabled) => writePanelPref(FORMAT_ON_SAVE_KEY, enabled)}
								syntaxTheme={readSyntaxThemePref()}
								onSyntaxThemeChange={writeSyntaxThemePref}
								diffMode={readDiffModePref()}
								onDiffModeChange={writeDiffModePref}
								showDiff={showDiff}
								objectMenuContext={fileMenuContext}
								openCitation={(entry) => {
									void openEntity(getCodeEditorRuntime(), {
										entityId: entry.entityId,
										entityType: entry.entityType,
									});
								}}
								onContentChange={onContentChange}
							/>
						) : null}
						{selectedRow ? (
							<ReferencesPanel
								row={selectedRow}
								content={settledContent}
								refs={refs}
								onReveal={revealLine}
							/>
						) : null}
					</>
				)}
			</main>
		</>
	);
}

// ── References inspector (SH-14) ─────────────────────────────────────────────

function ReferencesPanel({
	row,
	content,
	refs,
	onReveal,
}: {
	row: CodeFileRow;
	content: string;
	refs: CitationReference[];
	onReveal: (line: number) => void;
}): ReactElement {
	return (
		<aside className="editor__refs glass--strong" tabIndex={-1} aria-label={t("referencesRegion")}>
			<DiagnosticsList content={content} language={row.language} onReveal={onReveal} />
			<div className="editor__refs-head">{t("referencesHeading")}</div>
			{refs.length === 0 ? (
				<EmptyState
					className="editor__refs-empty"
					tone={EmptyStateTone.Compact}
					icon={IconName.KindLink}
					title={t("referencesEmpty")}
				/>
			) : null}
			<div className="editor__refs-list">
				{refs.map((ref) => {
					const { entry } = ref;
					return (
						<button
							// Keyed on the cited entry alone — folding the first line into the
							// key remounted every row whenever a line was added above it.
							key={entry.key}
							type="button"
							className="editor__ref"
							title={t("referenceOpen", { code: entry.code, title: entry.title })}
							onClick={() => {
								void openEntity(getCodeEditorRuntime(), {
									entityId: entry.entityId,
									entityType: entry.entityType,
								});
							}}
						>
							<div className="editor__ref-top">
								<span className="editor__ref-code">{entry.code}</span>
								<span className="editor__ref-status" data-status={entry.status}>
									{entry.status || KIND_LABEL[entry.kind]()}
								</span>
								{ref.count > 1 ? (
									<span
										className="editor__ref-count"
										title={t("referenceOccurrences", { count: ref.count, line: ref.firstLine })}
									>
										{t("referenceCount", { count: ref.count })}
									</span>
								) : null}
							</div>
							<div className="editor__ref-title">{entry.title}</div>
							{entry.summary ? <div className="editor__ref-summary">{entry.summary}</div> : null}
						</button>
					);
				})}
			</div>
		</aside>
	);
}
