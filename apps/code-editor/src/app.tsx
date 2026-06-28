/**
 * Code-Editor — React app (all-apps-React track). Mirrors the theme-editor
 * reference conversion (9.9.7): a React root mounts the chrome (header, file
 * sidebar, references inspector, empty state), live vault data is read ONLY
 * through `@brainstorm/react-yjs` (`useVaultEntities`), and the editing
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

import { useVaultEntities } from "@brainstorm/react-yjs";
import { NavigationMode, navModeFromEvent, openEntity } from "@brainstorm/sdk";
import type { VaultEntitiesService } from "@brainstorm/sdk-types";
import { type CompositeItemProps, Orientation, useCompositeKeyboard } from "@brainstorm/sdk/a11y";
import { EmptyState } from "@brainstorm/sdk/empty-state";
import { type Icon as EntityIconValue, createEntityIconElement } from "@brainstorm/sdk/entity-icon";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import { recallLastViewed, rememberLastViewed } from "@brainstorm/sdk/last-viewed";
import { LockButton } from "@brainstorm/sdk/lock-button";
import { NavButtons, createNavHistory } from "@brainstorm/sdk/nav-history";
import {
	ObjectMenuMoreButton,
	ObjectMenuTrigger,
	openObjectMenu,
} from "@brainstorm/sdk/object-menu";
import { PanelSide, PanelToggleButton } from "@brainstorm/sdk/panel-toggle";
import { PopoverSize, createPopoverElement } from "@brainstorm/sdk/popover";
import { type ShortcutDisposer, attachShortcut } from "@brainstorm/sdk/shortcut";
import { publishTabIdentity } from "@brainstorm/sdk/tab-identity";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildCodeDemo, buildDemoCitationIndex } from "./demo/dataset";
import { type CodeEditorMessageKey, plural, t } from "./i18n";
import { type CitationIndex, CitationKind, buildCitationIndex } from "./logic/citation-index";
import { type CitationReference, collectReferences } from "./logic/citation-scan";
import { type CodeFileRow, projectCodeFiles } from "./logic/code-projection";
import { fileName, languageLabel } from "./logic/code-view";
import type { EditorCommand } from "./logic/command-palette";
import { lintCode } from "./logic/diagnostics";
import { RenameError, nextUntitledPath, validateRenamePath } from "./logic/new-file";
import { SyntaxThemePreference, parseSyntaxThemePreference } from "./logic/syntax-theme";
import {
	CODE_FILE_ENTITY_TYPE,
	type CodeEditorRuntime,
	type VaultSnapshot,
	getCodeEditorRuntime,
} from "./runtime";
import { CODE_EDITOR_CHORDS, CodeEditorAction } from "./shortcuts";
import { getYDocResolverApi } from "./store/ydoc-resolver";
import { LanguageKey } from "./types/code-file";
import { CodePaneHost, type CodePaneHostHandle } from "./ui/code-pane-host";
import { type CommandPaletteController, openCommandPalette } from "./ui/command-palette";
import { renderDiagnosticsList } from "./ui/diagnostics-list";
import { type DiffViewController, DiffViewMode, openDiffView } from "./ui/diff-view";
import { codeFileObjectMenuContext } from "./ui/object-menu-context";
import { type QuickOpenController, openQuickOpen } from "./ui/quick-open";

const EMPTY_CITATION_INDEX: CitationIndex = new Map();

/** Widening adapter — the generic diagnostics list takes a `(string) =>
 *  string` translator; the app's `t` has a narrower literal-key domain. */
const translateMsg = (key: string, params?: Record<string, string>): string =>
	t(key as CodeEditorMessageKey, params);

// ── Panel + editor preferences (device-local; same localStorage path as
// every other first-party app). ─────────────────────────────────────────
const NAV_OPEN_KEY = "code-editor:nav-open";
const REFS_OPEN_KEY = "code-editor:refs-open";
const WRAP_KEY = "code-editor:wrap";
const FORMAT_ON_SAVE_KEY = "code-editor:format-on-save";
const SYNTAX_THEME_KEY = "code-editor:syntax-theme";
const DIFF_MODE_KEY = "code-editor:diff-mode";

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

/** The object's own universal icon, rendered through the shared imperative
 *  primitive (the SDK has no React entity-icon outside `@brainstorm/editor`,
 *  which this app deliberately does not depend on). */
function EntityIcon({ icon, size }: { icon: EntityIconValue | null; size: number }): ReactElement {
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		const host = ref.current;
		if (!host) return;
		host.replaceChildren();
		const el = createEntityIconElement(icon, { size });
		if (el) host.appendChild(el);
	}, [icon, size]);
	return <span className="editor__file-icon" ref={ref} aria-hidden="true" />;
}

/** The diagnostics problem list (imperative builder) mounted via ref so the
 *  pure DOM module is reused unchanged inside the React inspector. */
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
	useEffect(() => {
		const host = ref.current;
		if (!host) return;
		host.replaceChildren(
			renderDiagnosticsList({
				diagnostics: lintCode(content, language),
				t: translateMsg,
				onReveal,
			}),
		);
	}, [content, language, onReveal]);
	return <div ref={ref} />;
}

export function CodeEditorApp(): ReactElement {
	const runtime = useMemo(() => getCodeEditorRuntime(), []);
	const [ready, setReady] = useState(false);

	const [rows, setRows] = useState<CodeFileRow[]>([]);
	const [citationIndex, setCitationIndex] = useState<CitationIndex>(EMPTY_CITATION_INDEX);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [edits, setEdits] = useState<Map<string, string>>(() => new Map());

	const [navOpen, setNavOpen] = useState(() => readPanelPref(NAV_OPEN_KEY, true));
	const [refsOpen, setRefsOpen] = useState(() => readPanelPref(REFS_OPEN_KEY, true));

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
			// (device-local, per-vault, app-namespaced — see `@brainstorm/sdk/last-viewed`).
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

	const createNewFile = useCallback(async (): Promise<void> => {
		const create = getCodeEditorRuntime()?.services?.entities?.create;
		if (!create) return;
		const path = nextUntitledPath(rowsRef.current.map((r) => r.path));
		try {
			const created = await create(CODE_FILE_ENTITY_TYPE, {
				path,
				content: "",
				language: LanguageKey.TypeScript,
			});
			if (created?.id) {
				pendingOpenIdRef.current = created.id;
				focusBufferOnOpenRef.current = true;
			}
		} catch (error) {
			console.warn("[code-editor] new file failed:", error);
		}
	}, []);

	const applyRename = useCallback(async (row: CodeFileRow, path: string): Promise<void> => {
		const update = getCodeEditorRuntime()?.services?.entities?.update;
		if (!update) return;
		try {
			await update(row.id, { path });
			setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, path } : r)));
		} catch (err) {
			console.warn("[code-editor] rename failed:", err);
		}
	}, []);

	const toggleFileLock = useCallback((): void => {
		const row = selectedRow;
		if (!row) return;
		const update = getCodeEditorRuntime()?.services?.entities?.update;
		if (!update) return;
		void update(row.id, { locked: !row.locked });
	}, [selectedRow]);

	const renameFile = useCallback(
		(row: CodeFileRow): void => {
			if (!getCodeEditorRuntime()?.services?.entities?.update) return;

			const field = document.createElement("form");
			field.className = "editor__rename-field";
			const input = document.createElement("input");
			input.type = "text";
			input.className = "editor__rename-input";
			input.value = row.path;
			input.setAttribute("aria-label", t("renameLabel"));
			const error = document.createElement("div");
			error.className = "editor__rename-error";
			error.id = "code-rename-error";
			error.setAttribute("role", "alert");
			error.hidden = true;
			input.setAttribute("aria-describedby", error.id);
			field.append(input, error);

			const actions = document.createElement("div");
			actions.className = "editor__rename-actions";
			const cancelBtn = document.createElement("button");
			cancelBtn.type = "button";
			cancelBtn.className = "bs-btn bs-btn--ghost";
			cancelBtn.textContent = t("renameCancel");
			const saveBtn = document.createElement("button");
			saveBtn.type = "button";
			saveBtn.className = "bs-btn";
			saveBtn.dataset.bsPrimary = "";
			saveBtn.textContent = t("renameSave");
			actions.append(cancelBtn, saveBtn);

			const handle = createPopoverElement({
				title: t("renameTitle", { name: fileName(row.path) }),
				body: field,
				footer: actions,
				size: PopoverSize.Small,
				testId: "code-rename",
				onClose: () => handle.close(),
			});

			const submit = (): void => {
				const result = validateRenamePath(
					input.value,
					row.path,
					rowsRef.current.map((r) => r.path),
				);
				if (!result.ok) {
					error.textContent =
						result.reason === RenameError.Empty ? t("renameErrorEmpty") : t("renameErrorDuplicate");
					error.hidden = false;
					input.setAttribute("aria-invalid", "true");
					input.focus();
					input.select();
					return;
				}
				handle.close();
				void applyRename(row, result.path);
			};
			cancelBtn.addEventListener("click", () => handle.close());
			saveBtn.addEventListener("click", submit);
			field.addEventListener("submit", (event) => {
				event.preventDefault();
				submit();
			});
			input.focus();
			const dot = row.path.lastIndexOf(".");
			input.setSelectionRange(0, dot > 0 ? dot : row.path.length);
		},
		[applyRename],
	);

	const deleteFile = useCallback(async (row: CodeFileRow): Promise<void> => {
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
			const editable = row.contentKey === "content";
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

	// ── Persist panel prefs ──────────────────────────────────────────────────
	useEffect(() => writePanelPref(NAV_OPEN_KEY, navOpen), [navOpen]);
	useEffect(() => writePanelPref(REFS_OPEN_KEY, refsOpen), [refsOpen]);

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

	const refs = useMemo(
		() => (selectedRow ? collectReferences(contentOf(selectedRow, edits), citationIndex) : []),
		[selectedRow, edits, citationIndex],
	);

	const selectedContent = selectedRow ? contentOf(selectedRow, edits) : "";
	const totalFiles = rows.length;
	const dirtyCount = useMemo(() => rows.filter((r) => isDirty(r, edits)).length, [rows, edits]);

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
					<div className="app-header__meta" id="header-meta">
						{metaText}
					</div>
					{selectedRow ? (
						<span className="editor__lang">{languageLabel(selectedRow.language)}</span>
					) : null}
					{canCreateFile ? (
						<button
							type="button"
							className="editor__header-new"
							data-bs-tooltip={t("newFileHint")}
							aria-label={t("newFileHint")}
							onClick={() => void createNewFile()}
						>
							<Icon name={IconName.Plus} size={16} />
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
						open={refsOpen}
						onClick={() => setRefsOpen((v) => !v)}
						labels={{ show: t("refsToggle.show"), hide: t("refsToggle.hide") }}
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
						<FileList
							rows={rows}
							selectedId={selectedId}
							edits={edits}
							canCreate={canCreateFile}
							onOpen={openRow}
							onCreate={createNewFile}
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
								content={selectedContent}
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

// ── File sidebar ────────────────────────────────────────────────────────────

function FileList({
	rows,
	selectedId,
	edits,
	canCreate,
	onOpen,
	onCreate,
	menuContext,
}: {
	rows: CodeFileRow[];
	selectedId: string | null;
	edits: ReadonlyMap<string, string>;
	canCreate: boolean;
	onOpen: (row: CodeFileRow, mode: NavigationMode) => void;
	onCreate: () => void | Promise<void>;
	menuContext: (row: CodeFileRow) => ReturnType<typeof codeFileObjectMenuContext>;
}): ReactElement {
	// Listbox keyboard model via the shared a11y reducer (no raw `e.key`) —
	// same posture as the Preview file sidebar. Selection follows the active
	// item (select === open), so ArrowUp/Down rove + load and Enter/Space opens.
	const activeIndex = useMemo(() => rows.findIndex((r) => r.id === selectedId), [rows, selectedId]);
	const openAt = useCallback(
		(index: number): void => {
			const target = rows[index];
			if (target) onOpen(target, NavigationMode.Replace);
		},
		[rows, onOpen],
	);
	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Vertical,
		count: rows.length,
		activeIndex,
		onActiveIndexChange: openAt,
		onActivate: openAt,
		useAriaActiveDescendant: true,
	});

	return (
		<nav className="editor__files" aria-label={t("filesRegion")}>
			<div className="editor__files-head">
				<span className="editor__files-heading">{t("filesHeading")}</span>
				{canCreate ? (
					<button
						type="button"
						className="editor__file-new"
						title={t("newFileHint")}
						onClick={() => void onCreate()}
					>
						{t("newFile")}
					</button>
				) : null}
			</div>
			<div {...containerProps} className="editor__file-list" aria-label={t("filesRegion")}>
				{rows.map((row, index) => (
					<FileRow
						key={row.id}
						row={row}
						current={row.id === selectedId}
						dirty={isDirty(row, edits)}
						itemProps={getItemProps(index)}
						onOpen={onOpen}
						menuContext={menuContext}
					/>
				))}
			</div>
		</nav>
	);
}

/** A single file-list row. Mirrors the imperative `attachObjectMenuTrigger`
 *  row: the `.editor__file` element is itself the object-menu host (carrying
 *  `aria-current` for the selected-row style + the row keyboard semantics),
 *  with a right-click opener and the trailing ⋯ `ObjectMenuMoreButton`. */
function FileRow({
	row,
	current,
	dirty,
	itemProps,
	onOpen,
	menuContext,
}: {
	row: CodeFileRow;
	current: boolean;
	dirty: boolean;
	itemProps: CompositeItemProps;
	onOpen: (row: CodeFileRow, mode: NavigationMode) => void;
	menuContext: (row: CodeFileRow) => ReturnType<typeof codeFileObjectMenuContext>;
}): ReactElement {
	const moreActionsLabel = t("menuMoreActions", { name: fileName(row.path) });
	const context = useCallback(() => menuContext(row), [menuContext, row]);
	const onContextMenu = useCallback(
		(event: React.MouseEvent) => {
			const ctx = context();
			if (!ctx) return;
			event.preventDefault();
			void openObjectMenu({ x: event.clientX, y: event.clientY }, ctx);
		},
		[context],
	);
	return (
		<div
			{...itemProps}
			className="editor__file bs-object-menu__host bs-object-menu__host--row"
			aria-current={current ? "true" : "false"}
			data-file-id={row.id}
			onContextMenu={onContextMenu}
		>
			<button
				type="button"
				className="editor__file-open"
				title={row.path}
				tabIndex={-1}
				onClick={(event) => onOpen(row, navModeFromEvent(event.nativeEvent))}
				onAuxClick={(event) => {
					if (event.button === 1) onOpen(row, navModeFromEvent(event.nativeEvent));
				}}
			>
				<EntityIcon icon={row.icon} size={15} />
				<span className="editor__file-name">{fileName(row.path)}</span>
				{dirty ? <span className="editor__file-dirty" aria-label={t("fileUnsaved")} /> : null}
			</button>
			<ObjectMenuMoreButton context={context} moreActionsLabel={moreActionsLabel} />
		</div>
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
			<div className="editor__refs-list">
				{refs.length === 0 ? (
					<div className="editor__refs-empty">{t("referencesEmpty")}</div>
				) : (
					refs.map((ref) => {
						const { entry } = ref;
						return (
							<button
								key={`${entry.entityId}:${ref.firstLine}`}
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
					})
				)}
			</div>
		</aside>
	);
}
