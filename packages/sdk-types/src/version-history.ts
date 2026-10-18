/**
 * Version history (doc `version-history.md`, rung 10.16) — the wire contract
 * between the shell's `history` service and the shared History panel.
 *
 * History is device-local (OQ-VH-1). On a shared object, Editors and above may
 * preview and restore; Viewers see the version list only — times, principals
 * and cause, never earlier content (OQ-VH-2).
 */

/** Why a checkpoint was taken. Wire values are stored in `entity_versions`. */
export enum VersionCause {
	/** 2 min after the last write, ≤1 per 10 min per entity, only if changed. */
	Idle = "idle",
	/** Before a multi-entity write (bulk edit, change-type). */
	BeforeBulk = "before-bulk",
	/** Before a restore, so a restore is itself undoable. */
	BeforeRestore = "before-restore",
	/** Before an agent run's first write to an entity. */
	AgentRun = "agent-run",
	/** Before an import overwrote an existing entity. */
	Import = "import",
	Manual = "manual",
}

export enum HistoryPrincipalKind {
	/** A person — a vault identity (base64url Ed25519 public key). */
	Member = "member",
	/** An agent — the broker-verified app id that acted. */
	Agent = "agent",
}

export type HistoryPrincipal = {
	kind: HistoryPrincipalKind;
	id: string;
	/** Display label resolved by the shell; the raw id when nothing better. */
	label: string;
	isSelf: boolean;
};

/** What the caller may do with an entity's history (OQ-VH-2). */
export enum HistoryAccess {
	/** Preview content, diff properties, restore. */
	Restore = "restore",
	/** The version list only — no earlier content. */
	ListOnly = "list-only",
}

export type VersionSummary = {
	versionId: string;
	entityId: string;
	at: number;
	cause: VersionCause;
	changeSetId: string | null;
	principals: HistoryPrincipal[];
};

export type VersionHistoryList = {
	access: HistoryAccess;
	/** Newest first. */
	versions: VersionSummary[];
};

export enum VersionPropertyChangeKind {
	/** The key exists now but not in the version (restore clears it). */
	Added = "added",
	/** The key existed in the version but not now (restore brings it back). */
	Removed = "removed",
	Changed = "changed",
}

export type VersionPropertyChange = {
	key: string;
	kind: VersionPropertyChangeKind;
	/** Value in the version. */
	then: unknown;
	/** Value now. */
	now: unknown;
};

export type VersionPreview = {
	versionId: string;
	at: number;
	properties: Record<string, unknown>;
	changes: VersionPropertyChange[];
	/** The version's rich-text body flattened to plain text, read-only. */
	bodyText: string;
};

export type VersionRestoreResult = {
	/** The `BeforeRestore` checkpoint taken first — restoring it undoes this. */
	beforeRestoreVersionId: string;
};

export enum RevertSkipReason {
	/** Someone outside the change set edited it afterwards — never clobbered. */
	EditedSince = "edited-since",
	Deleted = "deleted",
	Locked = "locked",
	Denied = "denied",
}

export type RevertSkipped = {
	entityId: string;
	/** The entity's title, so the UI can list what was left alone by name. */
	title: string;
	reason: RevertSkipReason;
};

export type ChangeSetRevertResult = {
	reverted: string[];
	skipped: RevertSkipped[];
	/** The `BeforeRestore` change set the revert itself recorded. */
	revertChangeSetId: string;
};

/** App-facing history surface. No capability of its own: every call is gated
 *  server-side by the entity's own `entities.read:<type>` (list / preview) or
 *  `entities.write:<type>` (restore / revert), plus the OQ-VH-2 role rule. */
export type VersionHistoryService = {
	list(entityId: string): Promise<VersionHistoryList>;
	preview(input: { entityId: string; versionId: string }): Promise<VersionPreview>;
	restore(input: { entityId: string; versionId: string }): Promise<VersionRestoreResult>;
	revertChangeSet(changeSetId: string): Promise<ChangeSetRevertResult>;
};
