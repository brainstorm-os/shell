/**
 * `<BrainstormEditor>` — the pre-configured, Yjs-backed editing surface.
 *
 * Takes a `Y.Doc` directly (the 9.1 `useYDoc(doc)` path). Resolving an
 * `entityId` to its replica Y.Doc is the SDK entities service's job at
 * Stage 9.3 — a thin `<BrainstormEntityEditor entityId=…>` wrapper will
 * sit on top then, reusing this component unchanged.
 *
 * Lexical state is bound to the doc through `@lexical/yjs`'s
 * CollaborationPlugin (always — see `local-provider.ts`). `HistoryPlugin`
 * is intentionally absent: `CollaborationPlugin` already mounts the Yjs
 * `UndoManager` internally (`useYjsHistory`) scoped to the binding's
 * root XmlText, and wires `UNDO_COMMAND` / `REDO_COMMAND` to it (so
 * `Mod+Z` / `Mod+Shift+Z` round-trip through the CRDT undo stack with
 * selection-tracking and remote-edit isolation). Stacking Lexical
 * `HistoryPlugin` on top would double-apply.
 *
 * Initial-state seeding under collaboration goes through the
 * `initialEditorState` prop — forwarded to `<CollaborationPlugin>`,
 * which fires it once when (and only when) the doc's root XmlText is
 * still empty (`root._xmlText._length === 0`). That length check makes
 * the seeder structurally idempotent across concurrent opens: the second
 * client to attach sees a non-empty root and skips its own bootstrap.
 */

import { TextSurfaceKind, spellcheckForSurface } from "@brainstorm/sdk/spellcheck";
import { CollaborationPlugin } from "@lexical/react/LexicalCollaborationPlugin";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import type { InitialEditorStateType } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import type { Provider } from "@lexical/yjs";
import type { Klass, LexicalNode } from "lexical";
import { type MutableRefObject, type ReactNode, useCallback, useEffect, useMemo } from "react";
import type { Doc } from "yjs";
import { type BrainstormEditorConfigOptions, createEditorConfig } from "./config";
import { EditorI18nProvider, type EditorManifest } from "./i18n";
import { createLocalProvider } from "./local-provider";
import { BASELINE_NODES } from "./nodes";
import { VirtualizePlugin } from "./virtualize-plugin";

export type BrainstormEditorProps = BrainstormEditorConfigOptions & {
	/** The entity's replica Y.Doc (9.1 `useYDoc(doc)` path). */
	doc: Doc;
	/** Key the doc is registered under for `@lexical/yjs`. One editing
	 *  surface per `(doc, docId)`. Defaults to `"main"`. */
	docId?: string;
	/** Class on the contenteditable host. */
	contentClassName?: string;
	/** Shown until the first sync / when empty. */
	placeholder?: ReactNode;
	/** Provider override (Stage 10 networked transport). Defaults to a
	 *  no-transport local provider over `doc`. */
	providerFactory?: (doc: Doc, docId: string) => Provider;
	/** Additional Lexical node classes registered alongside the baseline
	 *  set. Used by app-specific surfaces (Notes' Title / Mention /
	 *  Property blocks, etc.) — appended to `BASELINE_NODES`, never
	 *  replacing it. */
	additionalNodes?: ReadonlyArray<Klass<LexicalNode>>;
	/** Extra plugins / decorators mounted inside the composer alongside
	 *  the baseline plugin tree. The app owns lifecycle / ordering of
	 *  these (a Notes-specific TitlePlugin, MentionTypeaheadPlugin, etc.
	 *  go in here without forking the editor package). */
	children?: ReactNode;
	/** One-shot bootstrap seeder forwarded to `<CollaborationPlugin>`'s
	 *  `initialEditorState`. Fires once on the FIRST client to attach to
	 *  an empty doc (`root._xmlText._length === 0`) and never again on
	 *  that doc — so per-app title / template seeding is idempotent
	 *  across concurrent opens by construction. A function variant runs
	 *  inside an `editor.update` already tagged `history-merge`; the
	 *  string / `EditorState` variants are also supported. */
	initialEditorState?: InitialEditorStateType;
	/** When `doc` came from `react-yjs`'s `useYDoc(entityId)` resolver,
	 *  this is the resolver's `loaded` promise — fires once the canonical
	 *  snapshot has been applied to the replica. Gates the local
	 *  provider's `sync(true)` so CollaborationPlugin's bootstrap seeder
	 *  doesn't write into a still-empty doc and end up duplicated against
	 *  the late-arriving snapshot. Omit (or `undefined`) when `doc` is
	 *  already fully populated — the provider then fires sync on the
	 *  next microtask as before. */
	whenLoaded?: Promise<void>;
	/** When `doc` came from `react-yjs`'s `useYDoc(entityId)` resolver,
	 *  this is the resolver's `applyPending` callback. The LocalProvider
	 *  triggers it from inside `connect()` so the snapshot's
	 *  `Y.applyUpdate` lands AFTER `@lexical/yjs`'s `observeDeep` has been
	 *  registered. Without this sequencing the binding never sees the
	 *  snapshot's update events and the editor renders blank on reopen
	 *  (regression: `tests/perf/specs/repro-note-loss.spec.ts`). */
	applyPending?: () => Promise<void>;
	/** Host-app overrides for editor-internal strings (table toolbar,
	 *  slash menu, block-gutter labels — keys defined in `i18n.tsx`).
	 *  Defaults to the English manifest baked into the editor package.
	 *  Apps that already maintain their own i18n manifests (Notes,
	 *  Journal) only need to pass overrides for the strings they
	 *  localise; unset keys fall through to the defaults. */
	i18nOverrides?: Partial<EditorManifest>;
	/** Local collaborator identity (B11.9). When set, the name + caret
	 *  colour are published into the Yjs awareness channel via
	 *  `CollaborationPlugin` so remote peers render this client's cursor
	 *  with a stable colour + label. Omit on solo surfaces — awareness
	 *  stays quiet and no presence is broadcast. Derive `color` from
	 *  `peerColor(doc.clientID)` and bound `name` with `sanitizePeerName`
	 *  (`@brainstorm/editor`). */
	presence?: { name: string; color: string };
	/** Container the remote-cursor DOM (caret + label + selection rects)
	 *  is portalled into. Defaults to `document.body` (upstream default).
	 *  Pass a positioned element inside the editor's scroll container to
	 *  anchor carets to the scrolling content. */
	cursorsContainerRef?: MutableRefObject<HTMLElement | null>;
};

export function BrainstormEditor(props: BrainstormEditorProps): ReactNode {
	const {
		doc,
		docId = "main",
		contentClassName = "bs-editor__contenteditable",
		placeholder = null,
		providerFactory,
		namespace,
		theme,
		editable,
		onError,
		additionalNodes,
		children,
		initialEditorState,
		whenLoaded,
		applyPending,
		i18nOverrides,
		presence,
		cursorsContainerRef,
	} = props;

	const initialConfig = useMemo(() => {
		// Build options omitting `undefined` keys (exactOptionalPropertyTypes).
		const opts: BrainstormEditorConfigOptions = {};
		if (namespace !== undefined) opts.namespace = namespace;
		if (theme !== undefined) opts.theme = theme;
		if (editable !== undefined) opts.editable = editable;
		if (onError !== undefined) opts.onError = onError;
		const base = createEditorConfig(opts);
		if (!additionalNodes || additionalNodes.length === 0) return base;
		return { ...base, nodes: [...BASELINE_NODES, ...additionalNodes] };
	}, [namespace, theme, editable, onError, additionalNodes]);

	const makeProvider = useCallback(
		(id: string, yjsDocMap: Map<string, Doc>): Provider => {
			yjsDocMap.set(id, doc);
			if (providerFactory) return providerFactory(doc, id);
			const localOpts: { whenLoaded?: Promise<void>; applyPending?: () => Promise<void> } = {};
			if (whenLoaded) localOpts.whenLoaded = whenLoaded;
			if (applyPending) localOpts.applyPending = applyPending;
			return createLocalProvider(doc, localOpts);
		},
		[doc, providerFactory, whenLoaded, applyPending],
	);

	return (
		<EditorI18nProvider {...(i18nOverrides ? { overrides: i18nOverrides } : {})}>
			<LexicalComposer initialConfig={initialConfig}>
				<RichTextPlugin
					contentEditable={
						<ContentEditable
							className={contentClassName}
							spellCheck={spellcheckForSurface(TextSurfaceKind.Prose)}
						/>
					}
					placeholder={<div className="bs-editor__placeholder">{placeholder}</div>}
					ErrorBoundary={LexicalErrorBoundary}
				/>
				<CollaborationPlugin
					id={docId}
					providerFactory={makeProvider}
					shouldBootstrap
					{...(initialEditorState !== undefined ? { initialEditorState } : {})}
					{...(presence ? { username: presence.name, cursorColor: presence.color } : {})}
					{...(cursorsContainerRef ? { cursorsContainerRef } : {})}
				/>
				<ListPlugin />
				<LinkPlugin />
				<VirtualizePlugin />
				<EditableSync editable={editable} />
				{children}
			</LexicalComposer>
		</EditorI18nProvider>
	);
}

/**
 * Reactively applies the `editable` prop after mount. `initialConfig.editable`
 * only seeds the FIRST render — Lexical never re-reads it — so without this a
 * lock/unlock toggle (e.g. a read-only object lock) wouldn't flip the live
 * contenteditable. `undefined` means "leave editable" (the default).
 */
function EditableSync({ editable }: { editable: boolean | undefined }): null {
	const [editor] = useLexicalComposerContext();
	useEffect(() => {
		if (editable === undefined) return;
		editor.setEditable(editable);
	}, [editor, editable]);
	return null;
}
