/**
 * React-island mount helper for the Tasks inspector body editor.
 *
 * `apps/tasks/src/app.ts` is a plain-DOM scaffold; only the inspector
 * body needs the editor stack. Rather than convert the whole app to
 * React, we mount a single `createRoot()` whose tree wraps
 * `<TaskInspectorEditor>` in the shell-installed `<YDocProvider>`. The
 * root lives for the app's lifetime — when the user selects a different
 * task, `update(taskId, …)` re-renders and React reconciles in place.
 *
 * Standalone (`vite preview` / harness without the preload) has no
 * entities-doc surface; `getYDocResolverApi()` returns null, this helper
 * returns `null`, and the caller falls back to a read-only legacy-notes
 * paragraph. The editor never mounts there.
 */

import { YDocProvider } from "@brainstorm-os/react-yjs";
import {
	BlockRendererRegistryProvider,
	DEFAULT_BUILTIN_CUSTOM_NODES,
	createBlockRendererRegistry,
} from "@brainstorm-os/sdk/block-registry";
import { type Root, createRoot } from "react-dom/client";
import { getBrainstorm } from "../storage/runtime";
import { getYDocResolverApi } from "../store/ydoc-resolver";
import { TaskInspectorEditor } from "./inspector-editor";

/** Resolve which app renders a given BP block id so an embedded task lights
 *  up the app's own `inline-task` block (9.14.3). Built once per mount from
 *  the live `blocks` service; absent in preview, where the embed degrades to
 *  the static fallback card. Mirrors `apps/notes/src/main.tsx`. */
function buildBlockRegistry() {
	const blocks = getBrainstorm()?.services.blocks;
	return createBlockRendererRegistry(
		blocks
			? {
					builtInCustomNodes: DEFAULT_BUILTIN_CUSTOM_NODES,
					bpResolver: async (blockId: string) => {
						const info = await blocks.resolve(blockId);
						return info ? { appId: info.appId, name: info.name } : null;
					},
				}
			: { builtInCustomNodes: DEFAULT_BUILTIN_CUSTOM_NODES },
	);
}

export type TaskInspectorHandle = {
	/** Re-render against a different task. Cheap — same root, React diffs.
	 *  `key={taskId}` remounts the editor subtree so `@lexical/yjs`'s
	 *  CollaborationPlugin rebinds to the new task's Y.Doc. */
	update(
		taskId: string,
		opts: { seedNotes?: string; onFirstEdit?(): void; editable?: boolean },
	): void;
	/** Tear down the React tree + release the resolver refcount. */
	dispose(): void;
};

/** Mount the inspector editor island into `host`. Returns a handle, or
 *  `null` if the resolver isn't available (preview / standalone) — in
 *  which case the caller keeps its read-only fallback. */
export function mountTaskInspectorEditor(
	host: HTMLElement,
	taskId: string,
	opts: { seedNotes?: string; onFirstEdit?(): void; editable?: boolean },
): TaskInspectorHandle | null {
	const resolverApi = getYDocResolverApi();
	if (!resolverApi) return null;

	const root: Root = createRoot(host);
	const blockRegistry = buildBlockRegistry();
	const render = (
		id: string,
		o: { seedNotes?: string; onFirstEdit?(): void; editable?: boolean },
	): void => {
		// NOT wrapped in <StrictMode>: its dev double-mount re-binds the
		// `@lexical/yjs` editor to an already-applied Y.Doc, whose `observeDeep`
		// then fires no events → the task notes render blank on reopen.
		// StrictMode is a production no-op; dropping it makes dev match the
		// shipped app. (Same fix + rationale as `apps/notes/src/main.tsx`.)
		root.render(
			<BlockRendererRegistryProvider registry={blockRegistry}>
				<YDocProvider resolver={resolverApi.resolve}>
					<TaskInspectorEditor
						key={id}
						taskId={id}
						editable={o.editable ?? true}
						{...(o.seedNotes !== undefined ? { seedNotes: o.seedNotes } : {})}
						{...(o.onFirstEdit ? { onFirstEdit: o.onFirstEdit } : {})}
					/>
				</YDocProvider>
			</BlockRendererRegistryProvider>,
		);
	};
	render(taskId, opts);

	return {
		update(nextTaskId, nextOpts) {
			render(nextTaskId, nextOpts);
		},
		dispose() {
			root.unmount();
		},
	};
}
