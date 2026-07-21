/**
 * Right-sidebar properties panel — a React island mounted into Journal's
 * plain-DOM shell (mirrors the existing `entry-editor-mount.tsx` pattern).
 *
 * A thin adapter over the SHARED `@brainstorm-os/sdk/properties-panel`, so the
 * Journal inspector reads pixel-identical to Notes' and Database's (same
 * 44px header, `.bs-props__*` rows + cells, metadata footer). Journal maps
 * the focused day's `entry.values` to the generic `rows`, surfaces date-key /
 * word-count / created / updated as `meta`, and binds un-bound properties via
 * the shared select menu (`openSelectMenu`). An "Open in Notes" hint rides in
 * the panel body (`children`) so users discover the richer editor.
 *
 * No `addPropertyStore` dependency (that store is Notes-internal) — the
 * picker is intentionally minimal.
 *
 * `mountJournalProperties(host, opts)` returns a handle whose `render()`
 * the app calls after any state change that may have flipped the focused
 * day (calendar click, back/forward, vault-update). React reconciles the
 * tree; no per-render unmount.
 */

import {
	type CommentsFocusRequest,
	CommentsProvider,
	CommentsRightPanel,
	type RightPanelTab,
} from "@brainstorm-os/editor";
import type { CommentAnchor, CommentDef, RosterService } from "@brainstorm-os/sdk-types";
import type { PropertiesPanelMeta } from "@brainstorm-os/sdk/properties-panel";
import {
	EntityPropertiesPanel,
	PropertiesProvider,
	type ValuesMap,
} from "@brainstorm-os/sdk/property-ui";
import { useSelfDisplayName } from "@brainstorm-os/sdk/self-display-name";
import { type JSX, useCallback, useMemo } from "react";
import { type Root, createRoot } from "react-dom/client";
import { type JournalT, journalPlural } from "../logic/journal-i18n";
import type { JournalRuntime } from "../runtime";
import { useJournalCommentsAdapter } from "../store/comments-bindings";
import type { JournalEntry } from "../types/entry";

export type JournalPropertiesOptions = {
	runtime: JournalRuntime | null;
	t: JournalT;
	getEntry: () => JournalEntry | null;
	/** Create today's entry on demand — bound to `app.ts`'s
	 *  `ensureJournalEntry`. Returns the new note id, or null if the
	 *  entities service is unavailable / creation rejected. */
	ensureEntry: () => Promise<string | null>;
	onClose: () => void;
	/** Comments tab state (B11.9) — owned by `app.ts` so the editor's
	 *  comment entry points can force-switch the panel to the Comments tab.
	 *  All optional: a host without them renders properties-only. */
	getActiveTab?: () => RightPanelTab;
	onTabChange?: (tab: RightPanelTab) => void;
	getPendingCommentAnchor?: () => CommentAnchor | null;
	onClearPendingComment?: () => void;
	getCommentFocusRequest?: () => CommentsFocusRequest | null;
	/** Suggestion apply (B11.9) — lands the proposed edit in the live day
	 *  editor; `true` lets the panel resolve the thread. */
	onApplySuggestion?: (comment: CommentDef) => boolean | Promise<boolean>;
};

export type JournalPropertiesHandle = {
	render(): void;
	dispose(): void;
};

/** Mount the properties React island. Re-renders are triggered by
 *  `handle.render()`; the inner shell reads live state via its `opts`
 *  ref each pass. Returns a usable handle even when the shell has no
 *  `services.properties` (the catalog is empty + Add Property is
 *  disabled — the panel still surfaces date/word-count metadata). */
export function mountJournalProperties(
	host: HTMLElement,
	opts: JournalPropertiesOptions,
): JournalPropertiesHandle {
	const root: Root = createRoot(host);
	let tick = 0;
	const renderTree = (): void => {
		tick += 1;
		root.render(<JournalPropertiesIsland version={tick} opts={opts} />);
	};
	renderTree();
	return {
		render: renderTree,
		dispose: () => root.unmount(),
	};
}

export function JournalPropertiesIsland({
	version,
	opts,
}: { version: number; opts: JournalPropertiesOptions }) {
	// `version` participates in the React diff so an external `render()`
	// call from `app.ts` re-runs the subtree even when the `opts` object
	// reference is stable (it's captured once at mount).
	void version;
	// F-165 — a posted comment's author is your signed vault display name (or
	// key fingerprint if unset), not the renderer-local "Anonymous".
	const selfDisplayName = useSelfDisplayName(
		(opts.runtime?.services as { roster?: RosterService } | undefined)?.roster ?? null,
	);
	const propertiesRuntime = useMemo(() => {
		const svc = opts.runtime?.services as unknown as { properties?: unknown } | undefined;
		if (!svc?.properties) return null;
		// The SDK provider accepts a structural runtime — just the
		// properties service it needs. Cast through unknown because the
		// Journal runtime type only declares the surface the renderer
		// uses; the preload exposes more services than the type lists.
		return { services: { properties: svc.properties } } as unknown as Parameters<
			typeof PropertiesProvider
		>[0]["runtime"];
	}, [opts.runtime]);

	const entry = opts.getEntry();
	const noteId = entry?.noteId ?? null;
	// Live comments adapter for the focused day (B11.9) — null in preview /
	// standalone or when the day has no entry yet; the panel then renders
	// properties-only with no tab strip.
	const adapter = useJournalCommentsAdapter(noteId);

	// In tabbed mode the `CommentsRightPanel` tab strip already labels this
	// "Properties", so the inner shared panel suppresses its own header to
	// avoid a redundant double "Properties" header (F-252).
	const tabbed = Boolean(adapter && noteId && opts.getActiveTab && opts.onTabChange);
	const inner = <JournalPropertiesShell opts={opts} hideHeader={tabbed} />;
	const properties = propertiesRuntime ? (
		<PropertiesProvider runtime={propertiesRuntime}>{inner}</PropertiesProvider>
	) : (
		inner
	);

	if (!adapter || !noteId || !opts.getActiveTab || !opts.onTabChange) return properties;
	const pendingAnchor = opts.getPendingCommentAnchor?.() ?? null;
	return (
		<CommentsProvider adapter={adapter} authorName={selfDisplayName}>
			<CommentsRightPanel
				documentId={noteId}
				active={opts.getActiveTab()}
				onTabChange={opts.onTabChange}
				properties={properties}
				{...(pendingAnchor ? { pendingAnchor } : {})}
				{...(opts.onClearPendingComment ? { onClearPending: opts.onClearPendingComment } : {})}
				focusRequest={opts.getCommentFocusRequest?.() ?? null}
				{...(opts.onApplySuggestion ? { onApplySuggestion: opts.onApplySuggestion } : {})}
			/>
		</CommentsProvider>
	);
}

/** Journal's properties inspector — a thin adapter over the SHARED
 *  `@brainstorm-os/sdk/property-ui` `EntityPropertiesPanel` (the values-bag →
 *  editable-rows + add-menu body every entity app reuses), identical chrome to
 *  Notes / Database. Journal supplies the focused day's `values` bag, the
 *  write-through (which creates today's entry on demand), the `meta` footer,
 *  and the "Open in Notes" hint as `children`. */
function JournalPropertiesShell({
	opts,
	hideHeader,
}: { opts: JournalPropertiesOptions; hideHeader?: boolean }): JSX.Element {
	const t = opts.t;
	const entry = opts.getEntry();
	const updateEntity = opts.runtime?.services?.entities?.update;
	const canMutate = Boolean(updateEntity);

	const writeValues = useCallback(
		(next: ValuesMap): void => {
			void (async () => {
				let noteId = entry?.noteId ?? null;
				if (!noteId) noteId = await opts.ensureEntry();
				if (!noteId || !updateEntity) return;
				try {
					await updateEntity.call(opts.runtime?.services?.entities, noteId, { values: next });
				} catch (error) {
					console.warn("[journal] entities.update values failed:", error);
				}
			})();
		},
		[entry?.noteId, updateEntity, opts],
	);

	const values = entry?.values ?? {};

	const meta = useMemo<PropertiesPanelMeta[]>(() => {
		if (!entry) return [];
		return [
			{ label: t("properties.meta.dateKey"), value: entry.dateKey },
			{
				label: t("properties.meta.words"),
				value: journalPlural(t, entry.wordCount, "wordOne", "wordOther"),
			},
			{
				label: t("properties.meta.created"),
				value: formatAbsolute(entry.createdAt),
				title: new Date(entry.createdAt).toLocaleString(),
			},
			{
				label: t("properties.meta.updated"),
				value: formatAbsolute(entry.updatedAt),
				title: new Date(entry.updatedAt).toLocaleString(),
			},
		];
	}, [entry, t]);

	return (
		<EntityPropertiesPanel
			title={t("properties.title")}
			entityId={entry?.noteId ?? ""}
			values={values}
			canMutate={canMutate}
			onWriteValues={writeValues}
			emptyLabel={entry ? t("properties.empty") : t("noEntryYet")}
			addLabel={t("properties.add")}
			removeLabel={(name) => t("properties.remove", { name })}
			meta={meta}
			closeLabel={t("properties.hide")}
			{...(hideHeader ? { hideHeader: true } : { onClose: opts.onClose })}
		>
			<p className="journal__props-hint">{t("properties.openInNotesHint")}</p>
		</EntityPropertiesPanel>
	);
}

function formatAbsolute(epochMs: number): string {
	return new Date(epochMs).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}
