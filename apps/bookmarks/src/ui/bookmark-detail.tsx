/**
 * Bookmark detail surface — the Notes-like reading/editing view: a cover
 * band, icon + title-as-link + source, and the page's content in the SAME
 * editable `BrainstormEditor` (Lexical + Yjs) Notes / Journal / Tasks use.
 *
 * Body transport (9.18.7): the editor binds to the bookmark entity's
 * `brainstorm/UniversalBody/v1` Y.Doc via `useYDoc(bookmark.id)` +
 * `useUniversalBody(doc)`, persisted through the shared `entities.applyDoc`
 * resolver — the single source of truth every body-bearing entity shares.
 * The machine-captured page (9.18.5 `contentBlocks`) is the SEED: it plants
 * once into an empty body on first open (the shared CollaborationPlugin
 * bootstrap gate), and a re-capture re-plants imperatively (the fresh machine
 * extraction supersedes the prior one). User edits live in the body, not in
 * `contentBlocks` — `contentBlocks` stays the immutable capture source
 * (provenance + dedup read it).
 *
 * The right-side properties panel renders a bookmark's attributes through
 * the SHARED property-value cells (`BookmarkPropertiesPanel`), never
 * hand-rolled rows — a bookmark's URL / site / saved / status / tags are
 * vault PROPERTIES (see [[feedback-no-hand-rolled-property-panels]]).
 */

import {
	BrainstormEditor,
	EditorCapturePlugin,
	FULL_EDITOR_NODES,
	FullEditorPlugins,
} from "@brainstorm/editor";
import {
	useUniversalBody,
	useYDoc,
	useYDocApplyPending,
	useYDocLoaded,
} from "@brainstorm/react-yjs";
import { CoverKind } from "@brainstorm/sdk-types";
import type { Cover, PropertiesService, SerializedBlock } from "@brainstorm/sdk-types";
import { CoverPicker, type CoverPickerService } from "@brainstorm/sdk/cover-picker";
import { createEntityCoverElement } from "@brainstorm/sdk/entity-cover";
import { createEntityIconElement } from "@brainstorm/sdk/entity-icon";
import { IconName, createIconElement } from "@brainstorm/sdk/icon";
import { LockButton } from "@brainstorm/sdk/lock-button";
import { PropertiesProvider } from "@brainstorm/sdk/property-ui";
import { $getRoot, type LexicalEditor, type SerializedEditorState } from "lexical";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n/manifest";
import { CaptureState } from "../logic/capture-state";
import { isLargeCapture } from "../logic/provenance";
import { domainFromUrl } from "../logic/url-parse";
import type { Bookmark } from "../types/bookmark";
import { ContentProvenance } from "../types/bookmark";
import { BOOKMARK_BLOCK_PALETTE } from "./block-palette";
import { BookmarkPropertiesPanel } from "./bookmark-properties-panel";
import { useDomChild } from "./use-dom-child";

/** Drop `image` blocks recursively: the article's images are remote URLs the
 *  app CSP forbids (offline-first — no remote `<img>`), and a captured page's
 *  images aren't yet stored as local assets (a follow-on). The text content is
 *  the readable bulk. */
function stripImages(blocks: SerializedBlock[]): SerializedBlock[] {
	const out: SerializedBlock[] = [];
	for (const b of blocks) {
		if (b.type === "image") continue;
		if (Array.isArray(b.children)) {
			out.push({ ...b, children: stripImages(b.children as SerializedBlock[]) });
		} else {
			out.push(b);
		}
	}
	return out;
}

/** A single empty paragraph — the body "Forget content" reverts to (one empty
 *  block, like a fresh document). */
const EMPTY_STATE = {
	root: {
		type: "root",
		version: 1,
		direction: null,
		format: "",
		indent: 0,
		children: [
			{ type: "paragraph", version: 1, direction: null, format: "", indent: 0, children: [] },
		],
	},
} as unknown as SerializedEditorState;

/** Build a Lexical `SerializedEditorState` from captured blocks, or undefined
 *  for an empty body (the editor then shows its placeholder). */
function blocksToEditorState(
	blocks: SerializedBlock[] | undefined,
): SerializedEditorState | undefined {
	if (!blocks || blocks.length === 0) return undefined;
	const textOnly = stripImages(blocks);
	if (textOnly.length === 0) return undefined;
	return {
		root: { type: "root", version: 1, direction: null, format: "", indent: 0, children: textOnly },
	} as unknown as SerializedEditorState;
}

/** Older shells / the demo drop don't expose the `covers` service. The picker
 *  still works for Gallery / Color / Remove; the Image tab just has an empty
 *  library and a no-op upload (mirrors Notes). */
const COVERS_UNAVAILABLE: CoverPickerService = {
	uploadBytes: () => Promise.reject(new Error("covers service unavailable")),
	list: () => Promise.resolve([]),
};

export type BookmarkDetailProps = {
	bookmark: Bookmark;
	/** Edited property values (read/archived toggles + cover) map back to fields. */
	onPropertyChange: (partial: Partial<Bookmark>) => void;
	/** Vault covers service — backs the cover picker's upload/library. Null
	 *  outside the shell (demo / preview); the picker degrades gracefully. */
	covers: CoverPickerService | null;
	/** Vault property service — backs the shared property-value cells. Null
	 *  outside the shell (demo / preview); the panel is then hidden. */
	properties: PropertiesService | null;
	/** Whether the right-side properties inspector is shown (header toggle). */
	showProperties: boolean;
	/** Toggle the inspector — wired to the header toggle so the panel's own
	 *  close button shares one source of truth. */
	onToggleProperties: () => void;
	/** Derived capture lifecycle (9.18.12) — drives the in-detail "Capturing…" /
	 *  error feedback above the body. */
	captureState: CaptureState;
	/** Start (or retry) a readable-content capture of the page. */
	onCapture: () => void;
};

export function BookmarkDetail({
	bookmark,
	onPropertyChange,
	properties,
	covers,
	showProperties,
	onToggleProperties,
	captureState,
	onCapture,
}: BookmarkDetailProps): React.ReactElement {
	// The editable body lives in the bookmark entity's `UniversalBody/v1` Y.Doc,
	// resolved + persisted through the shared `entities.applyDoc` transport every
	// body-bearing entity uses. `useUniversalBody` subscribes to the body root so
	// a remote edit re-renders; the hydration gates make the first-open seeder
	// wait for the canonical snapshot (else the empty replica accepts the plant,
	// the snapshot lands late, and the CRDT keeps both inserts).
	const doc = useYDoc(bookmark.id);
	const whenLoaded = useYDocLoaded(bookmark.id);
	const applyPending = useYDocApplyPending(bookmark.id);
	useUniversalBody(doc);

	const [coverPickerOpen, setCoverPickerOpen] = useState(false);

	// The captured page (9.18.5) seeds the editable body. The epoch is bumped
	// only on a (re)capture (`contentFetchedAt`), never on keystroke edits.
	const epoch = bookmark.contentFetchedAt ?? 0;
	const seedState = useMemo(
		() => blocksToEditorState(bookmark.contentBlocks),
		[bookmark.contentBlocks],
	);

	// First-open seeder: plant the captured blocks into an EMPTY body exactly
	// once (the shared CollaborationPlugin bootstrap gate — `root.isEmpty()` —
	// no-ops against a body that already has content, so reopening never
	// re-plants over user edits). Built once per `seedState` value.
	const initialEditorState = useMemo(() => {
		if (!seedState) return undefined;
		return (editor: LexicalEditor) => {
			const root = $getRoot();
			if (!root.isEmpty()) return;
			try {
				editor.setEditorState(editor.parseEditorState(seedState));
			} catch (error) {
				console.warn("[bookmarks/detail] seed plant failed:", error);
			}
		};
	}, [seedState]);

	// Re-capture re-plant / forget: a capture while the detail is open bumps the
	// epoch and rewrites `contentBlocks`; "Forget content" zeroes the epoch and
	// drops `contentBlocks`. The first-open seeder won't fire (the body is no
	// longer empty), so apply the change to the body imperatively — a fresh
	// machine extraction supersedes the prior one, a forget clears it. Switching
	// to a different bookmark remounts the editor (keyed by id) and re-seeds via
	// the bootstrap path, so the baseline is reset to that bookmark's epoch and
	// no replant fires on the switch (only on a genuine in-place epoch change).
	const editorRef = useRef<LexicalEditor | null>(null);
	const seen = useRef({ id: bookmark.id, epoch });
	useEffect(() => {
		if (seen.current.id !== bookmark.id) {
			seen.current = { id: bookmark.id, epoch };
			return;
		}
		if (seen.current.epoch === epoch) return;
		seen.current = { id: bookmark.id, epoch };
		const editor = editorRef.current;
		if (!editor) return;
		editor.update(() => {
			try {
				editor.setEditorState(
					seedState ? editor.parseEditorState(seedState) : editor.parseEditorState(EMPTY_STATE),
				);
			} catch (error) {
				console.warn("[bookmarks/detail] body replant failed:", error);
			}
		});
	}, [bookmark.id, epoch, seedState]);

	// Provenance + large-page caution (9.18.13): when the body is a machine
	// extraction, tell the reader so + flag pages large enough to have been
	// truncated by the extractor's byte cap.
	const provenanceNote = useMemo<string | null>(() => {
		if (bookmark.contentProvenance !== ContentProvenance.MachineExtracted) return null;
		const at = bookmark.contentFetchedAt;
		const date = at ? new Date(at).toLocaleDateString() : "";
		return t("detail.provenance.machine", { date });
	}, [bookmark.contentProvenance, bookmark.contentFetchedAt]);
	const truncationNote = useMemo(
		() => (isLargeCapture(bookmark.contentBlocks) ? t("detail.truncation") : null),
		[bookmark.contentBlocks],
	);

	// Effective banner: the user's explicit cover wins; else the scraped
	// OpenGraph image; else the renderer's id-seeded gradient fallback.
	const effectiveCover: Cover | null = useMemo(
		() =>
			bookmark.cover ??
			(bookmark.coverImageUrl ? { kind: CoverKind.Image, value: bookmark.coverImageUrl } : null),
		[bookmark.cover, bookmark.coverImageUrl],
	);
	// Parity with Notes : the band shows
	// only when the bookmark has a real cover (its own or a scraped OG image) —
	// a coverless bookmark shows no band at all (no seeded-gradient placeholder,
	// no always-on "Add cover" button). Adding a cover lives in the object ⋯
	// menu; clicking an existing band opens the picker to change/remove it.
	const hasCover = effectiveCover !== null;
	const coverRef = useDomChild(
		() =>
			createEntityCoverElement(
				{ id: bookmark.id },
				// Slim banner aspect shared with the Notes editor (16 / 3.5), not the
				// taller 16 / 5 — so a bookmark's cover reads the same as a note's.
				{ aspect: 16 / 3.5, radius: 0, className: "bm-detail__cover-img" },
				effectiveCover,
			),
		[bookmark.id, effectiveCover],
	);

	const onPickCover = useCallback(
		(cover: Cover | null) => {
			onPropertyChange({ cover });
			setCoverPickerOpen(false);
		},
		[onPropertyChange],
	);

	const iconRef = useDomChild(() => {
		if (bookmark.icon) return createEntityIconElement(bookmark.icon, { size: 40 });
		if (bookmark.faviconUrl) {
			const img = document.createElement("img");
			img.src = bookmark.faviconUrl;
			img.alt = "";
			img.width = 40;
			img.height = 40;
			img.className = "bm-detail__favicon";
			return img;
		}
		return createIconElement(IconName.KindLink, { size: 28 });
	}, [bookmark.id, bookmark.icon, bookmark.faviconUrl]);

	const onEditorMount = useCallback((editor: LexicalEditor) => {
		editorRef.current = editor;
	}, []);
	const onEditorUnmount = useCallback(() => {
		editorRef.current = null;
	}, []);

	return (
		<div className="bm-detail">
			{hasCover ? (
				<button
					type="button"
					className="bm-detail__cover"
					aria-label={t("detail.cover.edit")}
					aria-haspopup="dialog"
					aria-expanded={coverPickerOpen}
					disabled={!!bookmark.locked}
					onClick={() => {
						if (bookmark.locked) return;
						setCoverPickerOpen((open) => !open);
					}}
				>
					<span ref={coverRef} aria-hidden="true" />
				</button>
			) : null}

			<div className="bm-detail__sheet">
				<div className="bm-detail__titlerow">
					<span className="bm-detail__icon" ref={iconRef} aria-hidden="true" />
					<h1 className="bm-detail__title">
						<a
							className="bm-detail__title-link"
							href={bookmark.url}
							target="_blank"
							rel="noopener noreferrer"
						>
							{bookmark.title || bookmark.url}
						</a>
					</h1>
					<LockButton
						locked={!!bookmark.locked}
						onToggle={() => onPropertyChange({ locked: !bookmark.locked })}
						lockLabel={t("detail.lock")}
						unlockLabel={t("detail.unlock")}
					/>
				</div>
				<a className="bm-detail__source" href={bookmark.url} target="_blank" rel="noopener noreferrer">
					{bookmark.siteName ?? domainFromUrl(bookmark.url) ?? bookmark.url}
				</a>
				{captureState === CaptureState.Capturing ? (
					<p className="bm-detail__capturing" role="status" aria-live="polite">
						{t("capture.capturing")}
					</p>
				) : null}
				{captureState === CaptureState.Error ? (
					<div className="bm-detail__capture-error" role="alert">
						<span>{t("capture.error")}</span>
						<button type="button" className="bm-detail__capture-retry" onClick={onCapture}>
							{t("capture.retry")}
						</button>
					</div>
				) : null}
				{truncationNote ? (
					<p className="bm-detail__truncation" role="note">
						{truncationNote}
					</p>
				) : null}
				{provenanceNote ? <p className="bm-detail__provenance">{provenanceNote}</p> : null}
				<div className="bm-detail__body">
					<BrainstormEditor
						key={bookmark.id}
						doc={doc}
						docId={bookmark.id}
						editable={!bookmark.locked}
						namespace="bookmarks"
						contentClassName="notes__contenteditable bm-detail__editor"
						additionalNodes={FULL_EDITOR_NODES}
						{...(initialEditorState ? { initialEditorState } : {})}
						{...(whenLoaded ? { whenLoaded } : {})}
						{...(applyPending ? { applyPending } : {})}
						placeholder={<span className="bm-detail__placeholder">{t("detail.bodyPlaceholder")}</span>}
						onError={(error) => {
							console.error("[bookmarks/detail]", error);
						}}
					>
						<FullEditorPlugins
							docId={bookmark.id}
							currentEntityId={bookmark.id}
							scrollContainerSelector=".bm-detail"
							palette={BOOKMARK_BLOCK_PALETTE}
						>
							<EditorCapturePlugin onMount={onEditorMount} onUnmount={onEditorUnmount} />
						</FullEditorPlugins>
					</BrainstormEditor>
				</div>
			</div>

			{/* The properties inspector is a fixed glass overlay (shared SDK
			 *  component); mounted whenever the vault service exists so it can
			 *  slide in/out, with `open` driving the slide. */}
			{properties ? (
				<PropertiesProvider runtime={{ services: { properties } }}>
					<BookmarkPropertiesPanel
						bookmark={bookmark}
						open={showProperties}
						onChange={onPropertyChange}
						onClose={onToggleProperties}
					/>
				</PropertiesProvider>
			) : null}

			{coverPickerOpen ? (
				<CoverPicker
					value={effectiveCover}
					covers={covers ?? COVERS_UNAVAILABLE}
					onChange={onPickCover}
					onClose={() => setCoverPickerOpen(false)}
				/>
			) : null}
		</div>
	);
}
