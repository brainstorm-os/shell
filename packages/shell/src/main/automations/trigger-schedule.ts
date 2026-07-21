/**
 * Pure scheduling core for the automations `SchedulerService` (11b.2).
 * Computes when a time trigger fires next and which registered triggers
 * are due — no timers, no IO, no clock of its own (every function takes
 * `now`/`after` explicitly) so it is exhaustively testable and the
 * service is a thin timer + persistence shell over it.
 *
 * **OQ-165 resolved (reuse, not a parallel dialect).** Time triggers
 * store the structured `@brainstorm-os/sdk-types` `Recurrence` — whose
 * `Custom { rrule }` arm already holds a raw RFC-5545 string for the long
 * tail — and we reuse the 9.15.5 `nextOccurrence` engine wholesale rather
 * than introduce a second RRULE storage/parser. One recurrence
 * representation across Tasks / Calendar / Automations. (A `Custom` RRULE
 * has no in-tree expander yet, so `nextOccurrence` returns null for it —
 * such a trigger simply never auto-fires until the expander lands; it can
 * still be run manually.)
 */

import { type Recurrence, nextOccurrence } from "@brainstorm-os/sdk-types";

/** What a one-shot trigger does when it comes due while the scheduler
 *  wasn't running to fire it (the app was closed). `Skip` (the default,
 *  and the only behaviour before 0.3.1) drops it — it registers dormant on
 *  next launch. `FireOnce` catches it up: it fires exactly once on the next
 *  launch if it came due since the scheduler last ran (the `lastRun`
 *  watermark). Item alerts (task/event reminders) opt into `FireOnce`;
 *  workflow Time triggers keep `Skip` (a missed 3am workflow shouldn't run
 *  at 9am on launch). */
export enum OnMissedPolicy {
	Skip = "skip",
	FireOnce = "fire-once",
}

/** A time trigger's `config`: a recurring rule, a one-shot instant, or
 *  both (earliest wins). Epoch milliseconds. */
export type TimeTriggerConfig = {
	recurrence?: Recurrence;
	oneShotAt?: number;
	/** Missed-fire policy for a one-shot (default `Skip`). See {@link OnMissedPolicy}. */
	onMissed?: OnMissedPolicy;
};

/**
 * The next instant strictly greater than `after` at which this config
 * fires, or `null` when it has no future fire (a past one-shot, an empty
 * config, or a `Custom` RRULE with no in-tree expander). When both a
 * one-shot and a recurrence are present, the earlier upcoming one wins.
 */
export function computeNextFire(config: TimeTriggerConfig, after: number): number | null {
	const oneShot =
		config.oneShotAt !== undefined && config.oneShotAt > after ? config.oneShotAt : null;
	const recurring = config.recurrence ? nextOccurrence(config.recurrence, after) : null;
	if (oneShot === null) return recurring;
	if (recurring === null) return oneShot;
	return Math.min(oneShot, recurring);
}

/**
 * The instant to arm a freshly-registered/hydrated trigger with, given the
 * persistent `lastRun` watermark (the last instant the scheduler was known
 * to be running). Like {@link computeNextFire} for the normal (strictly-
 * future) case, but adds **missed-fire catch-up** (0.3.1): a one-shot with
 * `onMissed: FireOnce` whose instant fell in `(lastRun, now]` — i.e. it came
 * due while the app was CLOSED — arms at that (past) instant so `dueFires`
 * fires it exactly once on the next tick, instead of going dormant. `Skip`
 * (the default) keeps the pre-0.3.1 behaviour: a past one-shot is dormant.
 *
 * Exactly-once falls out of the watermark: after the catch-up fires, the
 * service advances `lastRun` past the instant, so a re-hydration on the next
 * launch no longer sees it as missed.
 */
export function computeInitialFire(
	config: TimeTriggerConfig,
	now: number,
	lastRun: number,
): number | null {
	const future = computeNextFire(config, now);
	if (future !== null) return future;
	if (
		config.onMissed === OnMissedPolicy.FireOnce &&
		config.oneShotAt !== undefined &&
		config.oneShotAt > lastRun &&
		config.oneShotAt <= now
	) {
		return config.oneShotAt;
	}
	return null;
}

/** A trigger registered with the scheduler: its next fire instant and the
 *  workflows it drives (one trigger can fire many — doc 39 §Trigger). */
export type ScheduledFire = {
	triggerId: string;
	workflowIds: readonly string[];
	config: TimeTriggerConfig;
	/** Epoch ms of the next fire, or `null` for a spent/non-firing trigger
	 *  that stays registered but dormant. */
	nextFireAt: number | null;
};

/** The fires due at `now` (`nextFireAt` non-null and `<= now`), earliest
 *  first. Order is deterministic: by `nextFireAt`, then `triggerId`. */
export function dueFires(fires: readonly ScheduledFire[], now: number): ScheduledFire[] {
	return fires
		.filter(
			(f): f is ScheduledFire & { nextFireAt: number } => f.nextFireAt !== null && f.nextFireAt <= now,
		)
		.sort((a, b) => a.nextFireAt - b.nextFireAt || a.triggerId.localeCompare(b.triggerId));
}

/**
 * Advance a fired trigger to its next occurrence. A recurring trigger
 * re-arms (recompute from the fire instant, so a scheduler that wakes
 * late doesn't replay every missed slot — it jumps to the next future
 * one); a spent one-shot goes dormant (`nextFireAt: null`). Pure: returns
 * a new `ScheduledFire`.
 */
export function rescheduleAfterFire(fire: ScheduledFire, firedAt: number): ScheduledFire {
	return { ...fire, nextFireAt: computeNextFire(fire.config, firedAt) };
}

/** The earliest upcoming fire instant across all registered triggers, or
 *  `null` when none are armed — the service sleeps until this. */
export function earliestFireAt(fires: readonly ScheduledFire[]): number | null {
	let earliest: number | null = null;
	for (const f of fires) {
		if (f.nextFireAt === null) continue;
		if (earliest === null || f.nextFireAt < earliest) earliest = f.nextFireAt;
	}
	return earliest;
}
