import "@brainstorm/sdk/app-theme.css";
import { initAnalytics } from "@brainstorm/sdk/analytics";
import "@brainstorm/sdk/empty-state.css";
import "@brainstorm/sdk/share-dialog.css";
import { mountMenuHost } from "@brainstorm/sdk/menus";
import { mountSpellcheckMenuFromWindow } from "@brainstorm/sdk/spellcheck-menu";
import "@brainstorm/editor/editor.css";
import "@brainstorm/editor/editor-theme.css";
import { setEditorHost, setEntityIndexSource } from "@brainstorm/editor";
import { YDocProvider } from "@brainstorm/react-yjs";
import {
	BlockRendererRegistryProvider,
	DEFAULT_BUILTIN_CUSTOM_NODES,
	createBlockRendererRegistry,
} from "@brainstorm/sdk/block-registry";
import { AppErrorBoundary } from "@brainstorm/sdk/error-boundary";
import { applyPersistedPanelWidth } from "@brainstorm/sdk/resizable";
import { getWidgetLaunch } from "@brainstorm/sdk/widget";
import { createRoot } from "react-dom/client";
import { NotesApp } from "./app";
import { getBrainstorm, openEntityInShell } from "./store/runtime";
import { getYDocResolverApi } from "./store/ydoc-resolver";
import { NotesWidget } from "./widget";
import "./styles.css";

initAnalytics();

const root = document.getElementById("root");
if (!root) throw new Error("Notes: #root not found in index.html");

/** Mount the full Notes app (editor, nav, inspector). The widget path below
 *  short-circuits this — a dashboard widget needs none of the editor stack. */
function mountFullApp(mountRoot: HTMLElement): void {
	applyPersistedPanelWidth({
		storageKey: "notes:nav-width",
		cssVar: "--notes-nav-width",
		defaultWidth: 260,
	});
	applyPersistedPanelWidth({
		storageKey: "notes:props-width",
		cssVar: "--notes-props-width",
		defaultWidth: 320,
	});

	// 9.3.2b/9.3.5.N1 — build the renderer-side Y.Doc resolver the
	// YjsUniversalBody editor surface depends on. The resolver core lives
	// here (not the preload) because `contextBridge` cannot structured-clone
	// Y.Doc instances across worlds. Older shells / preview drops expose no
	// IPC primitives → `getYDocResolverApi()` returns null and we mount
	// without a provider; `useYDoc(entityId)` throws ONLY if a flag-gated
	// YJS surface tries to render before the runtime is up.
	const resolverApi = getYDocResolverApi();

	// 9.4.3 — block-renderer registry. The shell entity-card id is
	// pre-registered as the always-on custom-node fallback; `blocks.resolve`
	// from the runtime drives BP-block lookups. Built once per app boot —
	// the per-blockId promise cache lives on this instance, so a doc with
	// twenty embeds of the same id triggers one broker round-trip, not
	// twenty. Older shells / preview drops have no `services.blocks`, so
	// the resolver is omitted and every lookup goes straight to fallback.
	const runtime = getBrainstorm();

	// Wire the shared vault-entity index (title + icon lookups for mention /
	// page-ref / transclusion / block-embed decorators + the Link cell) to the
	// shell's `vaultEntities` service. The index lives in `@brainstorm/editor`,
	// decoupled from the runtime — Notes injects the source once at boot.
	const vaultEntities = runtime?.services.vaultEntities;
	if (vaultEntities) {
		setEntityIndexSource({
			list: () => vaultEntities.list(),
			onChange: (listener) => vaultEntities.onChange(listener),
		});
	}

	// Wire the editor's imperative host ops: open-entity navigation (mention
	// chips / link-markup / backlinks / transclusion cards) and media upload
	// (drag-drop / paste / `/image` etc.). The shared editor calls
	// `getEditorHost().openEntity` / `.uploadFile` instead of importing the
	// Notes runtime.
	const intents = runtime?.services.intents;
	const storage = runtime?.services.storage;
	setEditorHost({
		...(intents
			? {
					openEntity: (target) => {
						// A `#block-<id>` anchor (B11.13) rides the intent payload so the
						// receiving app can scroll to the linked block after opening.
						const { blockId, ...rest } = target;
						void openEntityInShell({
							...rest,
							...(blockId ? { payload: { blockId } } : {}),
						}).then((ok) => {
							if (!ok) console.warn("[notes/open-entity] open dispatch failed for", target.entityId);
						});
					},
				}
			: {}),
		...(storage
			? { uploadFile: (filename, bytes, mime) => storage.uploadFile(filename, bytes, mime) }
			: {}),
	});

	const blocksService = runtime?.services.blocks;
	const blockRegistry = createBlockRendererRegistry(
		blocksService
			? {
					builtInCustomNodes: DEFAULT_BUILTIN_CUSTOM_NODES,
					bpResolver: async (blockId: string) => {
						const info = await blocksService.resolve(blockId);
						return info ? { appId: info.appId, name: info.name } : null;
					},
				}
			: { builtInCustomNodes: DEFAULT_BUILTIN_CUSTOM_NODES },
	);

	// NOTE: intentionally NOT wrapped in <StrictMode>. StrictMode double-invokes
	// mount effects in dev; the `@lexical/yjs` editor binding fills Lexical only
	// from `observeDeep` events fired by the one-time snapshot apply, so the
	// SECOND (immediate) mount binds to an already-applied Y.Doc, receives no
	// events, and renders BLANK — the recurring "open a note, navigate away, come
	// back and it's empty" report. It cannot be fixed at the React layer (the
	// second StrictMode mount is not a new render, so the binding can't be handed
	// a fresh, not-yet-applied doc), and re-applying a doc's own state fires no
	// events. StrictMode is a no-op in production builds — this only affects dev —
	// so dropping it makes `bun run dev` behave like the shipped app. The
	// `BlankRecoveryPlugin` remains as a backstop for any non-StrictMode races.
	const tree = (
		<BlockRendererRegistryProvider registry={blockRegistry}>
			<NotesApp />
		</BlockRendererRegistryProvider>
	);

	// Stand up the fancy-menus runtime so object / context menus open through
	// the shared bridge (Stage 8.8).
	mountMenuHost();

	// B11.16c — render Chromium's spellcheck suggestions through fancy-menus when
	// the user right-clicks a misspelled word (Electron has no native menu).
	mountSpellcheckMenuFromWindow();

	createRoot(mountRoot).render(
		<AppErrorBoundary appName="notes">
			{resolverApi ? <YDocProvider resolver={resolverApi.resolve}>{tree}</YDocProvider> : tree}
		</AppErrorBoundary>,
	);
}

// Widget-mode (Stage 7.3): the dashboard launched this bundle as a widget. Mount
// the compact widget surface instead of the full editor app.
const widgetLaunch = getWidgetLaunch();
if (widgetLaunch) {
	mountMenuHost();
	createRoot(root).render(
		<AppErrorBoundary appName="notes">
			<NotesWidget launch={widgetLaunch} />
		</AppErrorBoundary>,
	);
} else {
	mountFullApp(root);
}
