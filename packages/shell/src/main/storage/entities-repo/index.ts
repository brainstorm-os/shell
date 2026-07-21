/**
 * Composite of all `entities.db` repositories. Constructed once per vault
 * session and threaded through the entities service.
 *
 * Per the Stage 5 repository-pattern decision: feature code interacts with
 * these typed methods; SQL stays in the individual repo files.
 */

import type { SqliteDatabase } from "@brainstorm-os/sqlite";
import { AssetDeksRepository } from "./asset-deks-repo";
import { AssetRefsRepository } from "./asset-refs-repo";
import { AssetsRepository } from "./assets-repo";
import { EntitiesRepository } from "./entities-repo";
import { EntityDeksRepository } from "./entity-deks-repo";
import { PendingRotationsRepository } from "./pending-rotations-repo";

export { DEFAULT_PATTERN_COST_CEILING, EntitiesRepository } from "./entities-repo";
export type {
	CreateEntityInput,
	EntityLink,
	EntityRow,
	PatternCostError,
	PatternMatch,
	PatternQueryResult,
	QueryPatternOptions,
	QueryPatternResult,
} from "./entities-repo";
export { EntityDeksRepository } from "./entity-deks-repo";
export type { CreateEntityDekInput, EntityDekRecord } from "./entity-deks-repo";
export { AssetsRepository } from "./assets-repo";
export type { AssetRecord, CreateAssetInput } from "./assets-repo";
export { AssetDeksRepository } from "./asset-deks-repo";
export type { AssetDekRecord, CreateAssetDekInput } from "./asset-deks-repo";
export { AssetRefsRepository } from "./asset-refs-repo";
export type { AssetRefRecord, CreateAssetRefInput } from "./asset-refs-repo";
export { PendingRotationsRepository } from "./pending-rotations-repo";
export type { PendingRotationRecord } from "./pending-rotations-repo";

export class EntitiesRepositories {
	readonly entities: EntitiesRepository;
	readonly entityDeks: EntityDeksRepository;
	readonly assets: AssetsRepository;
	readonly assetDeks: AssetDeksRepository;
	readonly assetRefs: AssetRefsRepository;
	readonly pendingRotations: PendingRotationsRepository;

	constructor(db: SqliteDatabase) {
		this.entities = new EntitiesRepository(db);
		this.entityDeks = new EntityDeksRepository(db);
		this.assets = new AssetsRepository(db);
		this.assetDeks = new AssetDeksRepository(db);
		this.assetRefs = new AssetRefsRepository(db);
		this.pendingRotations = new PendingRotationsRepository(db);
	}
}
