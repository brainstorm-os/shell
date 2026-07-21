/**
 * Bridge to the shell's app preload. Mirrors `apps/graph/src/app.ts`'s
 * lightweight `BrainstormRuntime` shape — we type only the surface the
 * Journal renderer uses today (lifecycle `on("ready", …)` + the service
 * slices below). `vaultEntities` carries the full sdk-types contract so
 * the shared comments hooks accept it; the local `VaultSnapshot` aliases
 * stay for the projection helpers, which the sdk snapshot satisfies
 * structurally.
 *
 * `getJournalRuntime()` returns null when the renderer boots outside
 * the shell (`vite preview`, isolated dev) — exactly when the app
 * falls back to the in-memory demo dataset per [[preview-drop-pattern]].
 */

import type { BpService, VaultEntitiesService } from "@brainstorm-os/sdk-types";
import type { SaveFileService } from "@brainstorm-os/sdk/export-file";
import type { NoteLike } from "./logic/journal-projection";

export type VaultEntity = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
	deletedAt: number | null;
	ownerAppId: string;
};

export type VaultLink = {
	id: string;
	sourceEntityId: string;
	destEntityId: string;
	linkType: string;
	createdAt: number;
	deletedAt: number | null;
};

export type VaultSnapshot = {
	entities: VaultEntity[];
	links: VaultLink[];
};

export type IntentsService = {
	dispatch(intent: {
		verb: string;
		payload: Record<string, unknown>;
	}): Promise<unknown>;
};

/** Shell UI surface — the slice Journal uses to post the write-reminder
 *  notification (cap `notifications.post`). Optional; absent in preview /
 *  standalone, where the reminder scheduler silently no-ops. */
export type UiService = {
	notify?(notification: { title: string; body?: string }): unknown;
};

/** File-upload slice of `services.storage` — backs the shared editor's
 *  media blocks (drag-drop / paste / `/image`). */
export type StorageService = {
	uploadFile(
		filename: string,
		bytes: Uint8Array,
		mime?: string,
	): Promise<{ url: string; hash: string; ext: string; size: number; mime: string }>;
};

/** Block-registry slice (`blocks.read`, a default-minimum grant) — backs
 *  the shared editor's `/embed` entity card: `forType` resolves the
 *  providing app's live block for an entity type, `source` fetches its
 *  bundle for the sandboxed mount. Optional; absent in preview /
 *  standalone, where the embed renders the generic chrome card. */
export type BlocksService = {
	forType(entityType: string): Promise<string | null>;
	source(blockId: string): Promise<string | null>;
};

/** Dashboard pin surface — used by the shared object menu to label and
 *  toggle Pin / Unpin. Optional: absent in standalone mode. */
export type DashboardService = {
	pin?(target: { entityId: string }): Promise<boolean>;
	unpin?(target: { entityId: string }): Promise<boolean>;
	isPinned?(target: { entityId: string }): Promise<boolean>;
};

/** What the shell's entity mutations return — mirrors the real entities
 *  service (Notes types the same shape); the narrow per-method typings
 *  below only declare the surface Journal reads. */
export type EntityRecord = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
};

/** The slice of `services.entities` the renderer-side Y.Doc resolver +
 *  the implicit-create / icon-update paths need. Optional — the preview /
 *  standalone build exposes none of these; the editor mount falls back
 *  to the read-only paragraph and the icon-picker silently does nothing. */
export type EntitiesDocService = {
	loadDoc(entityId: string): Promise<{ snapshotB64?: string | null }>;
	applyDoc(entityId: string, updateB64: string): Promise<unknown> | undefined;
	closeDoc(entityId: string): Promise<unknown> | undefined;
	/** Idempotent — used by Journal to implicit-create today's entry on
	 *  first user gesture (typing or icon-pick). Passing the stable
	 *  `journal-<dateKey>` id keeps re-clicks from minting duplicates;
	 *  a collision rejects with `Invalid` which the caller treats as
	 *  "entry already exists, fall through". */
	create?(type: string, properties: Record<string, unknown>, id?: string): Promise<EntityRecord>;
	/** Patch one or more properties on an existing entity — used by the
	 *  icon picker to set `properties.icon` on the day's note. */
	update?(id: string, patch: Record<string, unknown>): Promise<EntityRecord>;
	/** Hard-delete an entity — used by the comments adapter (B11.9) to
	 *  remove a `Comment/v1`. Optional; absent in preview / standalone. */
	delete?(id: string): Promise<void>;
};

/** Inbound update bridge — the main process pushes Y.Doc updates that
 *  arrived from another renderer / sync source via this subscription. */
export type YDocBridge = {
	onRemote(
		entityId: string,
		listener: (updateB64: string) => void,
	): { unsubscribe?: () => void } | (() => void);
};

export type JournalLifecycleIntentEvent = {
	type: "intent";
	intent: { verb: string; payload?: Record<string, unknown> };
};

export type JournalRuntime = {
	on(event: "ready", handler: () => void): void;
	/** A sibling app (or the launcher) dispatched a curated verb while
	 *  Journal was already open; the launcher just focuses the window, so the
	 *  renderer re-reacts here (e.g. `open` → focus the linked day). */
	on(event: "intent", handler: (event: JournalLifecycleIntentEvent) => void): void;
	/** The context this window was launched with. `reason === "open-entity"`
	 *  with an `entityId` means "land on this journal entry" — read on boot to
	 *  focus the right day instead of today. */
	launch?: { reason: string; entityId?: string };
	/** Capabilities the shell granted this app — read by the shared
	 *  object menu to decide whether Pin/Open are offered. */
	capabilities?: readonly string[];
	services?: {
		vaultEntities?: VaultEntitiesService;
		intents?: IntentsService;
		dashboard?: DashboardService;
		entities?: EntitiesDocService;
		ui?: UiService;
		/** Files-host save surface (Stage 9.10) — used by the date-range
		 *  export (9.16.12). Optional; absent in preview / standalone. */
		files?: SaveFileService;
		/** File-upload surface — backs the shared editor's media blocks
		 *  (drag-drop / paste / `/image`). Optional; absent in preview. */
		storage?: StorageService;
		/** Block-registry lookups for the shared editor's `/embed` card.
		 *  Optional; absent in preview / standalone. */
		blocks?: BlocksService;
		/** Block-Protocol dispatch for a live embedded block's graph traffic.
		 *  Optional; absent in preview / standalone. */
		bp?: BpService;
	};
	ydoc?: YDocBridge;
};

declare global {
	interface Window {
		brainstorm?: JournalRuntime | undefined;
	}
}

export function getJournalRuntime(): JournalRuntime | null {
	return (window as Window).brainstorm ?? null;
}

/** Journal entries are their own object type (distinct from Notes) so the
 *  Notes app's `{ type: Note/v1 }` query never surfaces them. Created /
 *  read / opened under this type; existing `journal-<date>` rows are
 *  re-typed by the shell entities migration. */
export const JOURNAL_ENTRY_TYPE = "io.brainstorm.journal/Entry/v1";

/** The Notes object type — retained here only so the backlinks panel can
 *  accept a *note* that references a journal entry as a valid backlink
 *  source (a journal entry can be linked from notes, not just other
 *  journal entries). */
export const NOTE_ENTITY_TYPE = "io.brainstorm.notes/Note/v1";

/** The projection consumes `NoteLike` rows. Map a vault entry
 *  entity to that shape — title comes from `properties.title` (the
 *  vault-entities-service projects `Note.title` here). Since
 *  9.3.5.N-notes.3 Notes writes to the real entities store with `body`
 *  in the property bag, so `aggregateSharedEntities` surfaces it and
 *  the journal preview now renders real body text (empty only for a
 *  legacy body-less or non-string body). */
export function vaultEntityToNoteLike(entity: VaultEntity): NoteLike {
	const title =
		typeof entity.properties.title === "string"
			? entity.properties.title
			: typeof entity.properties.name === "string"
				? entity.properties.name
				: "";
	const body = (entity.properties.body as unknown) ?? undefined;
	const wordCount =
		typeof entity.properties.wordCount === "number" ? entity.properties.wordCount : undefined;
	return {
		id: entity.id,
		title,
		body,
		icon: entity.properties.icon,
		values: entity.properties.values,
		mood: entity.properties.mood,
		habits: entity.properties.habits,
		...(wordCount !== undefined ? { wordCount } : {}),
		createdAt: entity.createdAt,
		updatedAt: entity.updatedAt,
	};
}

/** Filter a snapshot down to journal-entry entities (post-soft-delete) and
 *  map each through the adapter. Returns rows ready for
 *  `projectJournalEntries`. */
export function notesFromSnapshot(snapshot: VaultSnapshot): NoteLike[] {
	const out: NoteLike[] = [];
	for (const entity of snapshot.entities) {
		if (entity.type !== JOURNAL_ENTRY_TYPE) continue;
		if (entity.deletedAt !== null) continue;
		out.push(vaultEntityToNoteLike(entity));
	}
	return out;
}
