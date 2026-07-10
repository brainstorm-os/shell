/**
 * `RegistrySchedulerStore` (11b.2) — the concrete `SchedulerStore` the
 * `SchedulerService` persists through, backed by `registry.db`'s
 * `scheduler_fires` table.
 *
 * The service is written against the `SchedulerStore` port (so its tests can
 * pass an in-memory fake); this is the production adapter that makes the
 * fire schedule survive a shell restart. `PersistedFire` and the repo's
 * `SchedulerFireRecord` are the same shape — this is a thin, synchronous
 * pass-through (better-sqlite3 is sync; the port allows it).
 */

import type { SchedulerFiresRepository } from "../storage/registry-repo/scheduler-fires-repo";
import type { PersistedFire, SchedulerStore } from "./scheduler-service";

export class RegistrySchedulerStore implements SchedulerStore {
	constructor(private readonly repo: SchedulerFiresRepository) {}

	loadAll(): PersistedFire[] {
		return this.repo.listAll();
	}

	save(fire: PersistedFire): void {
		this.repo.save(fire);
	}

	remove(triggerId: string): void {
		this.repo.remove(triggerId);
	}

	loadLastRun(): number | null {
		return this.repo.loadLastRun();
	}

	saveLastRun(ts: number): void {
		this.repo.saveLastRun(ts);
	}
}
