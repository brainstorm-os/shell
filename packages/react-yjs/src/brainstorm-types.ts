/**
 * Host-contract types for the vault-entity hooks (`useVaultEntities`,
 * `createVaultListStore`, the universal-body helpers).
 *
 * These are the *structural* shapes this package reads off its host — a
 * knowledge-vault runtime that stores entities in per-document Yjs docs. They
 * are intentionally small and dependency-free so `@brainstorm-os/react-yjs`
 * stands alone as its own repo. In the Brainstorm monorepo the shell's richer
 * `@brainstorm-os/sdk-types` definitions are structurally assignable to these,
 * so nothing casts at the call site.
 *
 * If you are using this library outside Brainstorm, provide any object matching
 * these shapes — the hooks only ever call `list()` / `onChange()` and read the
 * version fields (`updatedAt` / `deletedAt`) to short-circuit re-renders.
 */

/** An unsubscribe handle, as returned by a coarse change channel. */
export type Subscription = {
	unsubscribe(): void;
};

/** A vault entity — the minimal shape the reactivity core fingerprints.
 *  `updatedAt` / `deletedAt` are the version signal; the rest is opaque
 *  payload passed straight through to the consumer. */
export type VaultEntity = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
	deletedAt: number | null;
	/** Id of the app that owns the entity (routing hint for `open` intents). */
	ownerAppId: string;
};

/** A directed link between two vault entities. */
export type VaultEntityLink = {
	id: string;
	sourceEntityId: string;
	destEntityId: string;
	linkType: string;
	createdAt: number;
	deletedAt: null;
};

/** A point-in-time list of the vault's entities and the links between them. */
export type VaultEntitiesSnapshot = {
	entities: VaultEntity[];
	links: VaultEntityLink[];
};

/** Optional narrowing passed to `list()`. */
export type VaultEntitiesListQuery = { types?: readonly string[]; limit?: number };

/** The slice of the host's vault service the hooks touch: an async `list()`
 *  plus a coarse `onChange()` staleness signal. A host may expose more (the
 *  Brainstorm shell adds pattern/source query methods); only these two are
 *  read here. */
export type VaultEntitiesService = {
	list(query?: VaultEntitiesListQuery): Promise<VaultEntitiesSnapshot>;
	onChange(listener: () => void): Subscription;
};

/**
 * Well-known name of the universal rich-text body root — the `Y.XmlText`
 * `@lexical/yjs` binds to (`doc.get("root", XmlText)`). Carrying the body via
 * Lexical's own root keeps a single source of truth across the editor, the
 * per-app workflows, and tests. Kept in one place so a `root` vs `Root` typo
 * is impossible by construction.
 */
export const UNIVERSAL_BODY_FRAGMENT_NAME = "root" as const;
