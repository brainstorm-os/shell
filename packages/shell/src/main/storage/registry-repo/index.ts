/**
 * Composite of all `registry.db` repositories. Constructed once per vault
 * session and threaded through `AppInstaller`, the future app-launcher, the
 * dashboard's installed-apps surface, etc.
 *
 * Per the Stage 5 repository-pattern decision: feature code interacts with
 * these typed methods; SQL stays in the individual repo files.
 */

import type { SqliteDatabase } from "@brainstorm-os/sqlite";
import { AppsRepository } from "./apps-repo";
import { BlocksRepository } from "./blocks-repo";
import { EntityTypesRepository } from "./entity-types-repo";
import { IntentsRepository } from "./intents-repo";
import { OpenersRepository } from "./openers-repo";
import { SchedulerFiresRepository } from "./scheduler-fires-repo";
import { WidgetsRepository } from "./widgets-repo";

export {
	AppsRepository,
	BlocksRepository,
	EntityTypesRepository,
	IntentsRepository,
	OpenersRepository,
	SchedulerFiresRepository,
	WidgetsRepository,
};
export type { AppRecord } from "./apps-repo";
export type { BlockRecord } from "./blocks-repo";
export type { EntityTypeRecord } from "./entity-types-repo";
export type { IntentQuery, IntentRecord } from "./intents-repo";
export type { OpenerRecord } from "./openers-repo";
export { OpenerTargetKind } from "./openers-repo";
export type { SchedulerFireRecord } from "./scheduler-fires-repo";
export type { WidgetRecord } from "./widgets-repo";

export class RegistryRepositories {
	readonly apps: AppsRepository;
	readonly openers: OpenersRepository;
	readonly blocks: BlocksRepository;
	readonly entityTypes: EntityTypesRepository;
	readonly widgets: WidgetsRepository;
	readonly intents: IntentsRepository;
	readonly schedulerFires: SchedulerFiresRepository;

	constructor(db: SqliteDatabase) {
		this.apps = new AppsRepository(db);
		this.openers = new OpenersRepository(db);
		this.blocks = new BlocksRepository(db);
		this.entityTypes = new EntityTypesRepository(db);
		this.widgets = new WidgetsRepository(db);
		this.intents = new IntentsRepository(db);
		this.schedulerFires = new SchedulerFiresRepository(db);
	}
}
