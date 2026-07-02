/**
 * System (plumbing) entity types — vault rows the PRODUCT writes to make
 * apps work (saved views, automation machinery, session/persistence and
 * sync-ledger records) rather than knowledge the user authored. Surfaces
 * that enumerate "every type in the vault" (the Database sidebar's derived
 * type-lists, the Graph SHOW filter, future search facets) use this to
 * group or de-emphasise plumbing away from the user's content (F-212): a
 * BrowsingHistory ledger is not a thing Mira made. The system
 * classification is presentation-only — it may group or de-emphasise, never
 * change query or filtering semantics.
 *
 * Membership rule: a type belongs here when the user never *creates* one
 * deliberately — it exists as a side effect of using an app. Reminders,
 * StylePacks, Tasks, Notes are deliberate creations with their own
 * management UX and MUST NOT be listed.
 *
 * The CHILD classification below is different: those rows ARE deliberate
 * user content, but only meaningful inside a parent container — and default
 * browse listings may exclude them (see its doc).
 */

export const SystemEntityType = {
	BrowsingHistory: "brainstorm/BrowsingHistory/v1",
	BrowsingSession: "brainstorm/BrowsingSession/v1",
	GraphExport: "brainstorm/graph-export/v1",
	ListView: "brainstorm/ListView/v1",
	ShortcutBindings: "brainstorm/ShortcutBindings/v1",
	SyncRun: "brainstorm/SyncRun/v1",
	Trigger: "brainstorm/Trigger/v1",
	Workflow: "brainstorm/Workflow/v1",
	WorkflowRun: "brainstorm/WorkflowRun/v1",
} as const;

export type SystemEntityType = (typeof SystemEntityType)[keyof typeof SystemEntityType];

export const SYSTEM_ENTITY_TYPES: ReadonlySet<string> = new Set(Object.values(SystemEntityType));

export function isSystemEntityType(entityType: string): boolean {
	return SYSTEM_ENTITY_TYPES.has(entityType);
}

/**
 * Parent-scoped child entity types — rows that only carry meaning inside
 * their container: a Message inside its Channel/Conversation, a Comment on
 * the document it annotates. The user authored them deliberately (so they
 * are NOT system types), but as top-level items they are noise: 36
 * "(untitled) · Message" rows burying the vault's real documents (F-318).
 *
 * Contract — unlike the presentation-only system set, universal browse
 * surfaces (the Files vault browser, the Database "All vault items" list)
 * EXCLUDE these from their default top-level listings. Scope is default
 * browsing only: search still indexes the content, and the parent apps
 * (Chat, Agent, the comments panel) remain the dedicated readers.
 *
 * Membership rule: a type belongs here when every row carries a required
 * reference to its parent and is never opened standalone.
 */
export const ChildEntityType = {
	Comment: "brainstorm/Comment/v1",
	Message: "brainstorm/Message/v1",
} as const;

export type ChildEntityType = (typeof ChildEntityType)[keyof typeof ChildEntityType];

export const CHILD_ENTITY_TYPES: ReadonlySet<string> = new Set(Object.values(ChildEntityType));

export function isChildEntityType(entityType: string): boolean {
	return CHILD_ENTITY_TYPES.has(entityType);
}

/**
 * The union of the two sets above — a type that *reads as plumbing* in a
 * type-enumerating surface, whether because the product wrote it (system)
 * or because it only means anything inside its parent container (child).
 * The Database sidebar's System disclosure and the Graph SHOW filter's
 * trailing dimmed group both partition on this ONE predicate so the fleet
 * cannot drift (Graph once partitioned on `isSystemEntityType` alone and
 * flooded the canvas legend with "Message (untitled)" chips as user
 * content).
 *
 * Contract mirrors the system set's: presentation-only — grouping and
 * de-emphasis, never query or filtering semantics. Surfaces that need the
 * finer distinction (Files/Database default-browse EXCLUSION applies to
 * child types only, never system types' grouping) keep using the
 * fine-grained predicates.
 */
export function isPlumbingEntityType(entityType: string): boolean {
	return SYSTEM_ENTITY_TYPES.has(entityType) || CHILD_ENTITY_TYPES.has(entityType);
}

function pluralize(word: string): string {
	if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
	if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
	return `${word}s`;
}

/** The parsed, title-cased name segment of a type id, or null when the id
 *  yields nothing usable. Drops a trailing `vN` version segment only when
 *  one is actually present (so a version-less `brainstorm/Task` keeps
 *  `Task`, not the `brainstorm` namespace) and normalises `_`/`-` to
 *  spaces. Shared by the singular and pluralised display names. */
function typeNameSegment(typeId: string): string | null {
	const parts = typeId.split("/").filter((p) => p.length > 0);
	const last = parts[parts.length - 1];
	const hasVersion = last !== undefined && /^v\d+$/i.test(last);
	let name = hasVersion ? parts[parts.length - 2] : last;
	if (!name) return null;
	name = name.replace(/[_-]+/g, " ").trim();
	if (!name) return null;
	return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The singular human label for a vault entity-type id — `brainstorm/Task/v1`
 * → `Task`, `io.brainstorm.notes/Note/v1` → `Note`; falls back to the raw id.
 * For captioning ONE entity (the Graph's untitled-node fallback, inspector
 * "Kind" rows); surfaces that enumerate types use `friendlyTypeName`.
 */
export function typeDisplayName(typeId: string): string {
	return typeNameSegment(typeId) ?? typeId;
}

/**
 * A human, pluralised label for a vault entity-type id — `brainstorm/Task/v1`
 * → `Tasks`; falls back to the raw id. Shared by every surface that
 * enumerates vault types (Database sidebar, Calendar source filters, …).
 */
export function friendlyTypeName(typeId: string): string {
	const name = typeNameSegment(typeId);
	return name === null ? typeId : pluralize(name);
}
