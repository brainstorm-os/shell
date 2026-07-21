/**
 * vault-entities — the read surface Graph / Database / Journal / Files
 * subscribe to for a unified `{ entities, links }` snapshot of the vault.
 *
 * This surface reads `entities.db` **directly** and exclusively — every
 * first-party app writes its objects there through the shared entities
 * service, and seeded content is written there by the seeder. There is no
 * `kv.json` scan. The public `vaultEntities.list()` envelope shape is
 * byte-for-byte unchanged, so the SDK proxy and every consuming app keep
 * working with zero app-side change.
 *
 * Documented edge semantics preserved:
 *  - dangling links are dropped — a link whose destination isn't in the
 *    snapshot is never returned (Graph must not paint edges to vertices it
 *    can't draw).
 *  - note→note edges are shell-derived from a `Note/v1` row's rich-text
 *    `body` via `note-entities-codec` (the entities service has no
 *    app-callable link API), so a note created straight through the
 *    entities repo still contributes its mention / link edges.
 *
 * Method surface (over the broker):
 *   - `vaultEntities.list()` → { entities, links } (full live snapshot)
 *   - `vaultEntities.queryPattern({ pattern })` → { ok, snapshot } |
 *     { ok:false, error } — **9.13.3**: the shell compiles the
 *     `GraphPattern` to a single cost-cap-guarded SQL JOIN (via the typed
 *     `EntitiesRepository.queryPattern`) and returns the matched subgraph
 *     in the SAME `{entities, links}` shape `list()` returns, so the
 *     Graph renderer's scene path needs no rewrite.
 */

import type { LinkDirection, PropertyDef } from "@brainstorm-os/sdk-types";
import type { ServiceHandler } from "../../ipc/broker";
import type {
	EntityLink,
	EntityRow,
	QueryPatternOptions,
	QueryPatternResult,
} from "../storage/entities-repo";
import { DEFAULT_PROPERTY_REF_RULES, derivePropertyRefLinks } from "./derive-property-ref-links";
import { deriveSharedPropertyLinks } from "./derive-shared-property-links";
import {
	type ListSourceBackend,
	type ListSourceQueryResult,
	queryListSource,
} from "./list-source-query";
import { NOTE_TYPE, noteToProjection } from "./note-entities-codec";
import type { GraphPattern } from "./pattern";

export type VaultEntity = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
	deletedAt: number | null;
	/** App id that owns the entity — useful for routing an `open` intent
	 *  back to the correct sandbox. */
	ownerAppId: string;
};

export type VaultLink = {
	id: string;
	sourceEntityId: string;
	destEntityId: string;
	linkType: string;
	/** Human-meaningful elaboration of *why* this link exists, beyond the
	 *  machine `linkType`: the shared value for a shared-attribute edge, or
	 *  the source property name for a property reference. Optional — body /
	 *  structured edges leave it unset. */
	detail?: string;
	createdAt: number;
	deletedAt: null;
};

export type VaultEntitiesSnapshot = {
	entities: VaultEntity[];
	links: VaultLink[];
};

/** Structural child types — rows that exist only as the internal
 *  structure of another object (a whiteboard's connector edges live in
 *  `entities.db` as their own rows so the board entity stays small, but
 *  they are not first-class objects). They must never surface as
 *  standalone vertices in the unified snapshot (Graph / Database) or in
 *  global search — the owning app reads them through its own typed
 *  `entities.query({ type: [...] })`, never this aggregator. */
export const STRUCTURAL_ENTITY_TYPES: ReadonlySet<string> = new Set<string>([
	"brainstorm/WhiteboardEdge/v1",
]);

/** The shell-bootstrapped vault root folder (mirrors
 *  `vault/session.ROOT_FOLDER_ENTITY_ID`; duplicated as a bare string so this
 *  module stays free of the electron-heavy session import). It is pure
 *  infrastructure — the container the Files app navigates from — so it must
 *  never surface as a standalone vertex in the unified snapshot (Graph /
 *  Database / search). Real user folders are unaffected. */
const ROOT_FOLDER_ENTITY_ID = "brainstorm/root-folder/v1";

/** Journal entries are their own object type but carry the same rich-text
 *  `body` shape as a Note, so their mention / link edges are re-derived the
 *  same way (the entities service has no app-callable link API). */
export const JOURNAL_ENTRY_TYPE = "io.brainstorm.journal/Entry/v1";

/** Object types whose `body` is walked for mention / reference edges. */
const BODY_PROJECTED_TYPES: ReadonlySet<string> = new Set<string>([NOTE_TYPE, JOURNAL_ENTRY_TYPE]);

export type VaultEntitiesOptions = {
	getVaultPath: () => string | null;
	/** The real `entities.db` repo for the active vault. Omitted in tests
	 *  that assert the no-repo empty-snapshot behaviour. */
	getEntitiesRepo?: () => Promise<SharedEntitiesRepo | null>;
	/** The active vault's property catalog (vault-level `PropertyDef`s).
	 *  Drives the catalog-driven property-reference edges (any `entityRef`
	 *  property → a graph link). Omitted in tests / before a vault opens. */
	getPropertyDefs?: () => Promise<ReadonlyArray<PropertyDef> | null>;
};

/** The slice of `EntitiesRepository` this surface reads — structural so
 *  the test can pass a stub. */
export type SharedEntitiesRepo = {
	query(q: Record<string, never>): ReadonlyArray<{
		id: string;
		type: string;
		properties: Record<string, unknown>;
		createdBy: string;
		createdAt: number;
		updatedAt: number;
	}>;
	linksFrom(entityId: string): ReadonlyArray<{
		id: string;
		sourceEntityId: string;
		destEntityId: string;
		linkType: string;
		createdAt: number;
	}>;
	/** Batched outgoing-link read across many sources — one SQL query for
	 *  the whole snapshot instead of N. Optional so older stubs in the test
	 *  suite (and the search-collector reuse path) still satisfy the type;
	 *  the service falls back to per-row `linksFrom` when missing. */
	linksFromMany?(entityIds: readonly string[]): ReadonlyArray<{
		id: string;
		sourceEntityId: string;
		destEntityId: string;
		linkType: string;
		createdAt: number;
	}>;
	/** Optional — only the real `EntitiesRepository` implements pattern
	 *  compilation; the search-collector / test stubs that reuse the
	 *  shared accessor don't, and the `list()` path never calls it. */
	queryPattern?(pattern: GraphPattern, options?: QueryPatternOptions): QueryPatternResult;
	/** Optional `ListSource` fast paths (9.12.3) — absent on stubs, where
	 *  the resolver falls back to the shared in-memory evaluator. */
	idsByTypes?(types: readonly string[]): readonly string[];
	idsByLink?(
		anchors: readonly string[],
		linkType: string,
		direction: LinkDirection,
	): readonly string[];
};

/** `queryPattern` rejection mirrored to the app (the Graph renderer
 *  shows a "Narrow the source" banner for the cost variant). */
export type PatternQueryError = {
	kind: "pattern-too-expensive" | "pattern-invalid";
	message: string;
};

export type PatternQueryEnvelopeResult =
	| { ok: true; snapshot: VaultEntitiesSnapshot }
	| { ok: false; error: PatternQueryError };

/** Notes identifiers + link types are owned by the pure
 *  `note-entities-codec` keystone and re-exported here so existing import
 *  sites (and the Graph app's per-edge styling, which reads these protocol
 *  strings) are unchanged. */
export {
	NOTE_MENTION_LINK_TYPE,
	NOTE_REFERENCE_LINK_TYPE,
	NOTE_TYPE,
} from "./note-entities-codec";
/** Derived link types — the `linkType` strings stamped on structured edges
 *  between first-party objects (Graph's per-edge styling reads them). The
 *  canonical definitions live in `link-types`; re-exported here so existing
 *  import sites are unchanged. */
export {
	ITERATION_IN_STAGE_LINK_TYPE,
	ITERATION_RESOLVES_OQ_LINK_TYPE,
	MILESTONE_IN_RELEASE_LINK_TYPE,
	STAGE_GATED_BY_MILESTONE_LINK_TYPE,
	STAGE_IN_RELEASE_LINK_TYPE,
	TASK_IN_PROJECT_LINK_TYPE,
} from "./link-types";

export function makeVaultEntitiesServiceHandler(options: VaultEntitiesOptions): ServiceHandler {
	return async (envelope) => {
		switch (envelope.method) {
			case "list":
				return await listVaultEntities(
					options.getVaultPath(),
					options.getEntitiesRepo,
					options.getPropertyDefs,
				);
			case "queryPattern": {
				const a = envelope.args[0];
				const pattern = a && typeof a === "object" ? (a as { pattern?: unknown }).pattern : undefined;
				return await queryVaultPattern(pattern, options.getEntitiesRepo);
			}
			case "querySource": {
				const a = envelope.args[0];
				const source = a && typeof a === "object" ? (a as { source?: unknown }).source : undefined;
				return await queryVaultListSource(source ?? null, options.getEntitiesRepo);
			}
			default: {
				const err = new Error(`unknown vaultEntities method: ${envelope.method}`);
				err.name = "Invalid";
				throw err;
			}
		}
	};
}

/**
 * Snapshot the vault's entities + links straight from `entities.db`. The
 * `vaultPath` argument is retained for signature stability (the kv scan it
 * once drove is retired in 9.3.5.R — the bridge runs at vault open); it is
 * no longer read here.
 */
export async function listVaultEntities(
	_vaultPath: string | null,
	getEntitiesRepo?: () => Promise<SharedEntitiesRepo | null>,
	getPropertyDefs?: () => Promise<ReadonlyArray<PropertyDef> | null>,
): Promise<VaultEntitiesSnapshot> {
	const out: VaultEntitiesSnapshot = { entities: [], links: [] };

	if (!getEntitiesRepo) return out;
	let repo: SharedEntitiesRepo | null;
	try {
		repo = await getEntitiesRepo();
	} catch (error) {
		// A storage hiccup must resolve with an empty snapshot, never reject
		// — every app's `vaultEntities.list()` depends on this not throwing
		// (the historical "list failed ×N forever" storm).
		const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		console.error(`[vault-entities] repo acquisition failed (empty snapshot): ${detail}`);
		return out;
	}
	if (!repo) return out;

	// The property catalog is best-effort: a failure here must not sink the
	// whole snapshot (the structural ref rules + everything else still
	// derive), it just disables the catalog-driven reference edges.
	let propertyDefs: ReadonlyArray<PropertyDef> = [];
	if (getPropertyDefs) {
		try {
			propertyDefs = (await getPropertyDefs()) ?? [];
		} catch (error) {
			const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			console.error(`[vault-entities] property catalog read failed (no ref edges): ${detail}`);
		}
	}

	try {
		collectSharedEntities(repo, out, propertyDefs);
	} catch (error) {
		const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		console.error(`[vault-entities] query failed (empty snapshot): ${detail}`);
		return { entities: [], links: [] };
	}

	// Drop dangling links — the destination must exist in the snapshot so
	// the Graph app doesn't render edges to vertices it can't draw.
	const entityIds = new Set(out.entities.map((e) => e.id));
	out.links = out.links.filter((l) => entityIds.has(l.destEntityId));

	return out;
}

/**
 * Read every live row from `entities.db` into the snapshot. Soft-deleted
 * rows never reach here (`repo.query` filters them). `Note/v1` rows get
 * their mention / link edges re-derived from `body` via the shared
 * `note-entities-codec` — the entities service has no app-callable link
 * API, so a note's edges live only in its rich-text body.
 */
function collectSharedEntities(
	repo: SharedEntitiesRepo,
	out: VaultEntitiesSnapshot,
	propertyDefs: ReadonlyArray<PropertyDef> = [],
): void {
	const rows = repo.query({});
	if (rows.length === 0) return;

	const liveIds: string[] = [];
	const noteRows: Array<{ id: string; body: unknown; bodyRefs: unknown; updatedAt: number }> = [];
	for (const row of rows) {
		if (STRUCTURAL_ENTITY_TYPES.has(row.type)) continue;
		if (row.id === ROOT_FOLDER_ENTITY_ID) continue;
		out.entities.push({
			id: row.id,
			type: row.type,
			properties: row.properties,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			deletedAt: null,
			ownerAppId: row.createdBy,
		});
		liveIds.push(row.id);
		if (BODY_PROJECTED_TYPES.has(row.type)) {
			noteRows.push({
				id: row.id,
				body: row.properties.body,
				bodyRefs: row.properties.bodyRefs,
				updatedAt: row.updatedAt,
			});
		}
	}

	// Stored links first — one batched query for the whole snapshot (was N+1
	// over `repo.linksFrom`). Falls back to per-row when the repo stub
	// doesn't implement the batch surface (older test stubs + the search
	// collector that reuses this accessor). Order matters: the dedupe at
	// the end keeps the first occurrence, so when a note's body-derived
	// edge collides with the same id already persisted by the backfill the
	// stored row wins (preserves the stored `createdAt`).
	const storedLinks = repo.linksFromMany
		? repo.linksFromMany(liveIds)
		: liveIds.flatMap((id) => Array.from(repo.linksFrom(id)));
	for (const l of storedLinks) {
		out.links.push({
			id: l.id,
			sourceEntityId: l.sourceEntityId,
			destEntityId: l.destEntityId,
			linkType: l.linkType,
			createdAt: l.createdAt,
			deletedAt: null,
		});
	}

	for (const note of noteRows) {
		const { links } = noteToProjection(note, note.id);
		for (const link of links) out.links.push(link);
	}

	// Property-ref edges (Folder.members → Folder/contains, …) — structured
	// edges whose data is already on the source entity's property bag but
	// never made it into the link table. One edge per listed entity id;
	// the dangling filter below strips refs to ids not in the snapshot.
	const refLinks = derivePropertyRefLinks(out.entities, DEFAULT_PROPERTY_REF_RULES, propertyDefs);
	for (const link of refLinks) out.links.push(link);

	// Shared-property edges (Bookmarks-with-same-tag, DesignDocs-in-same-
	// category, …) — inferred from the entity set, not stored. Re-derived
	// on every `list()` so they track the live property values; a stable
	// pair-edge id means a newly-tagged bookmark joins an existing edge
	// rather than creating a duplicate. The structural dedupe pass below
	// guarantees they can never collide with a stored link.
	const derivedLinks = deriveSharedPropertyLinks(out.entities);
	for (const link of derivedLinks) out.links.push(link);

	// A note→note edge can be present both as a stored `links` row and as
	// a body-derived edge with the same stable id; collapse to one.
	const seen = new Set<string>();
	out.links = out.links.filter((l) => {
		if (seen.has(l.id)) return false;
		seen.add(l.id);
		return true;
	});
}

/**
 * Resolve a Graph pattern against the real `entities.db` store: the
 * shell compiles it to one SQL JOIN (cost-cap-guarded) via the typed
 * `repo.queryPattern`, then returns the matched subgraph in the SAME
 * `{entities, links}` shape `list()` returns — so the Graph renderer's
 * scene path is unchanged. A storage hiccup resolves to an ok-but-empty
 * snapshot (never rejects — the "list failed ×N forever" failure mode);
 * a structural / semantic compile error or a cost-cap rejection comes
 * back as `{ ok: false, error }` for the renderer to surface.
 */
export async function queryVaultPattern(
	rawPattern: unknown,
	getEntitiesRepo?: () => Promise<SharedEntitiesRepo | null>,
): Promise<PatternQueryEnvelopeResult> {
	const empty: VaultEntitiesSnapshot = { entities: [], links: [] };
	if (!isGraphPatternShape(rawPattern)) {
		return {
			ok: false,
			error: { kind: "pattern-invalid", message: "pattern is not a well-formed GraphPattern" },
		};
	}
	if (!getEntitiesRepo) return { ok: true, snapshot: empty };

	let repo: SharedEntitiesRepo | null;
	try {
		repo = await getEntitiesRepo();
	} catch (error) {
		const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		console.error(`[vault-entities] queryPattern repo acquisition failed (empty): ${detail}`);
		return { ok: true, snapshot: empty };
	}
	if (!repo) return { ok: true, snapshot: empty };
	if (!repo.queryPattern) {
		// Repo implementation without pattern support (a stub / the
		// search collector reusing the shared accessor) — nothing to
		// match against, an ok-empty result keeps the renderer quiet.
		return { ok: true, snapshot: empty };
	}

	let queried: QueryPatternResult;
	try {
		queried = repo.queryPattern(rawPattern);
	} catch (error) {
		const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		console.error(`[vault-entities] queryPattern execution failed (empty): ${detail}`);
		return { ok: true, snapshot: empty };
	}

	if (!queried.ok) {
		if ("cost" in queried) {
			return {
				ok: false,
				error: {
					kind: "pattern-too-expensive",
					message: `pattern estimated ~${queried.cost.estimatedRows} joined rows (ceiling ${queried.cost.ceiling}); narrow the source`,
				},
			};
		}
		return {
			ok: false,
			error: {
				kind: "pattern-invalid",
				message: `pattern did not compile: ${queried.compile.error.code}`,
			},
		};
	}

	return { ok: true, snapshot: subgraphToSnapshot(queried.result.entities, queried.result.links) };
}

/**
 * Resolve a saved List's `ListSource` to its live member id set (9.12.3).
 * SQL fast paths when the real repo is behind the accessor; the shared
 * `@brainstorm-os/sdk/predicate-eval` evaluator (the renderer's own code) for
 * the filter-shaped kinds over a lazily-materialized row set. Repo
 * acquisition failures resolve ok-empty (the `list()` fail-soft posture);
 * malformed / oversized sources return the structured error.
 */
export async function queryVaultListSource(
	rawSource: unknown,
	getEntitiesRepo?: () => Promise<SharedEntitiesRepo | null>,
): Promise<ListSourceQueryResult> {
	if (!getEntitiesRepo) return { ok: true, ids: [] };

	let repo: SharedEntitiesRepo | null;
	try {
		repo = await getEntitiesRepo();
	} catch (error) {
		const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		console.error(`[vault-entities] querySource repo acquisition failed (empty): ${detail}`);
		return { ok: true, ids: [] };
	}
	if (!repo) return { ok: true, ids: [] };

	const liveRepo = repo;
	// Lazily materialize live rows ONCE for the evaluator-backed kinds —
	// `byFilter` / `byVocabulary` never read links, and `byType` / `byLink`
	// take the SQL fast paths on the real repo, so links materialize only
	// on a stub repo's byLink fallback.
	let vault: { entities: EntityRowWire[]; links: LinkRowWire[] } | null = null;
	const materialize = () => {
		if (vault) return vault;
		const rows = liveRepo.query({});
		const entities = rows.map((row) => ({
			id: row.id,
			type: row.type,
			properties: row.properties,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			deletedAt: null,
		}));
		const linkRows = liveRepo.linksFromMany ? liveRepo.linksFromMany(rows.map((row) => row.id)) : [];
		const links = linkRows.map((link) => ({
			id: link.id,
			sourceEntityId: link.sourceEntityId,
			destEntityId: link.destEntityId,
			linkType: link.linkType,
			createdAt: link.createdAt,
			deletedAt: null,
		}));
		vault = { entities, links };
		return vault;
	};

	const backend: ListSourceBackend = {
		...(liveRepo.idsByTypes ? { idsByTypes: liveRepo.idsByTypes.bind(liveRepo) } : {}),
		...(liveRepo.idsByLink ? { idsByLink: liveRepo.idsByLink.bind(liveRepo) } : {}),
		vault: materialize,
	};

	try {
		return queryListSource(rawSource, backend);
	} catch (error) {
		const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		console.error(`[vault-entities] querySource execution failed (empty): ${detail}`);
		return { ok: true, ids: [] };
	}
}

type EntityRowWire = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
	deletedAt: null;
};

type LinkRowWire = {
	id: string;
	sourceEntityId: string;
	destEntityId: string;
	linkType: string;
	createdAt: number;
	deletedAt: null;
};

/** Project the typed matched subgraph onto the wire `{entities, links}`
 *  snapshot — identical field shape to `list()` so the Graph renderer's
 *  `vaultSnapshotToInMemoryGraph` consumes it with zero change. Dangling
 *  links (dest not in the entity set) are dropped, exactly as `list()`
 *  does, so the renderer never paints an edge to a vertex it can't draw. */
function subgraphToSnapshot(
	entities: ReadonlyArray<EntityRow>,
	links: ReadonlyArray<EntityLink>,
): VaultEntitiesSnapshot {
	const ids = new Set(entities.map((e) => e.id));
	return {
		entities: entities.map((e) => ({
			id: e.id,
			type: e.type,
			properties: e.properties,
			createdAt: e.createdAt,
			updatedAt: e.updatedAt,
			deletedAt: null,
			ownerAppId: e.createdBy,
		})),
		links: links
			.filter((l) => ids.has(l.destEntityId) && ids.has(l.sourceEntityId))
			.map((l) => ({
				id: l.id,
				sourceEntityId: l.sourceEntityId,
				destEntityId: l.destEntityId,
				linkType: l.linkType,
				createdAt: l.createdAt,
				deletedAt: null,
			})),
	};
}

/** Structural guard on the untrusted wire payload. Semantic validation
 *  (unknown subject refs, empty link types, caps, multi-hop) is the
 *  compiler's job — this only rejects shapes the compiler can't even
 *  introspect without throwing. */
function isGraphPatternShape(value: unknown): value is GraphPattern {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (!v.subjects || typeof v.subjects !== "object") return false;
	if (!Array.isArray(v.edges)) return false;
	if (typeof v.primarySubject !== "string") return false;
	for (const subject of Object.values(v.subjects as Record<string, unknown>)) {
		if (!subject || typeof subject !== "object") return false;
		const s = subject as Record<string, unknown>;
		if (!Array.isArray(s.types)) return false;
		if (typeof s.displayName !== "string") return false;
	}
	for (const edge of v.edges) {
		if (!edge || typeof edge !== "object") return false;
		const e = edge as Record<string, unknown>;
		if (typeof e.from !== "string" || typeof e.to !== "string") return false;
		if (!Array.isArray(e.linkTypes)) return false;
		if (!Array.isArray(e.hops) || e.hops.length !== 2) return false;
	}
	return true;
}
