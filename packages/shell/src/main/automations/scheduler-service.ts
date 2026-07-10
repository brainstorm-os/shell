/**
 * `SchedulerService` (11b.2) — the shell-main owner of automation
 * triggers' fire schedule. Apps are not background processes (doc 03), so
 * the schedule lives here, not in the automations renderer: a workflow
 * fires whether or not its window is open.
 *
 * This is the timer-free core: it holds the registered triggers, persists
 * them through an injected `SchedulerStore` (so it survives restart), and
 * exposes `tick(now)` — drained by a real timer in the service wiring —
 * which returns the `WorkflowRunRequest`s due at `now` and re-arms
 * recurring triggers via the pure `trigger-schedule` engine. Keeping the
 * clock out of the class makes the whole fire/reschedule/persist path
 * exhaustively testable without fake timers.
 *
 * Scope: `Time` triggers (recurrence + one-shot). `EntityEvent` / `Manual`
 * wiring is 11b.6; `Webhook` / `FileWatch` / `Startup` are later slices.
 */

import {
	type ScheduledFire,
	type TimeTriggerConfig,
	computeInitialFire,
	dueFires,
	earliestFireAt,
	rescheduleAfterFire,
} from "./trigger-schedule";

/** A single (trigger → workflow) fire the runner should execute. */
export type WorkflowRunRequest = {
	triggerId: string;
	workflowId: string;
	firedAt: number;
};

/** The durable shape of a registered trigger (what survives restart). */
export type PersistedFire = {
	triggerId: string;
	workflowIds: string[];
	config: TimeTriggerConfig;
	nextFireAt: number | null;
};

/**
 * Persistence port — the registry.db adapter implements this; tests pass
 * an in-memory fake. Sync-or-async (the service awaits either) so a
 * better-sqlite3-backed store can stay synchronous.
 */
export interface SchedulerStore {
	loadAll(): Promise<PersistedFire[]> | PersistedFire[];
	save(fire: PersistedFire): Promise<void> | void;
	remove(triggerId: string): Promise<void> | void;
	/** The persisted `lastRun` watermark (the last instant the scheduler was
	 *  known to be running), or null when never persisted. Optional so a store
	 *  predating 0.3.1 missed-fire catch-up still satisfies the port. */
	loadLastRun?(): Promise<number | null> | number | null;
	saveLastRun?(ts: number): Promise<void> | void;
}

function toPersisted(fire: ScheduledFire): PersistedFire {
	return {
		triggerId: fire.triggerId,
		workflowIds: [...fire.workflowIds],
		config: fire.config,
		nextFireAt: fire.nextFireAt,
	};
}

export class SchedulerService {
	private readonly fires = new Map<string, ScheduledFire>();
	/** The last instant the scheduler was known to be running (advanced each
	 *  tick, persisted). Missed one-shots that came due in `(lastRun, now]`
	 *  while the app was closed catch up on next launch (0.3.1). Null until the
	 *  first hydrate/tick — treated as `now` at registration (no ancient
	 *  back-fire on a first-ever run). */
	private lastRun: number | null = null;

	constructor(private readonly store: SchedulerStore) {}

	/** The persisted `lastRun` watermark (for the item-alerts derivation, which
	 *  filters its registrations to instants `> lastRun`). */
	lastRunAt(): number | null {
		return this.lastRun;
	}

	/** Re-load the persisted schedule on boot. Idempotent. */
	async hydrate(): Promise<void> {
		this.lastRun = (await this.store.loadLastRun?.()) ?? null;
		this.fires.clear();
		for (const p of await this.store.loadAll()) {
			this.fires.set(p.triggerId, {
				triggerId: p.triggerId,
				workflowIds: p.workflowIds,
				config: p.config,
				nextFireAt: p.nextFireAt,
			});
		}
	}

	/**
	 * Register (or replace) a time trigger and the workflows it drives,
	 * computing its first fire after `now`. Persists immediately so a crash
	 * between registration and the first fire doesn't lose it.
	 */
	async register(
		triggerId: string,
		workflowIds: readonly string[],
		config: TimeTriggerConfig,
		now: number,
	): Promise<void> {
		const fire: ScheduledFire = {
			triggerId,
			workflowIds: [...workflowIds],
			config,
			nextFireAt: computeInitialFire(config, now, this.lastRun ?? now),
		};
		this.fires.set(triggerId, fire);
		await this.store.save(toPersisted(fire));
	}

	async unregister(triggerId: string): Promise<void> {
		if (this.fires.delete(triggerId)) await this.store.remove(triggerId);
	}

	/**
	 * The work due at `now`: one `WorkflowRunRequest` per (due trigger ×
	 * workflow), with recurring triggers re-armed and spent one-shots sent
	 * dormant — all changes persisted. Returns the requests in deterministic
	 * order for the caller to hand to the runner.
	 */
	async tick(now: number): Promise<WorkflowRunRequest[]> {
		const requests: WorkflowRunRequest[] = [];
		for (const due of dueFires([...this.fires.values()], now)) {
			for (const workflowId of due.workflowIds) {
				requests.push({ triggerId: due.triggerId, workflowId, firedAt: now });
			}
			const rearmed = rescheduleAfterFire(due, now);
			this.fires.set(due.triggerId, rearmed);
			await this.store.save(toPersisted(rearmed));
		}
		// Advance the watermark: we were running at `now`, so anything due at or
		// before it is not "missed while closed" on the next launch.
		this.lastRun = now;
		await this.store.saveLastRun?.(now);
		return requests;
	}

	/** The next instant the timer should wake to call `tick`, or `null`
	 *  when nothing is armed (the loop sleeps until a register/unregister
	 *  changes the schedule). */
	nextWakeAt(): number | null {
		return earliestFireAt([...this.fires.values()]);
	}

	/** Currently-registered trigger ids (stable order) — for introspection
	 *  (Settings → Automations, doc 39 §Discoverability). */
	registeredTriggerIds(): string[] {
		return [...this.fires.keys()].sort();
	}
}
