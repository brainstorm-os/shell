/**
 * `ReminderRunner` (11b.5) — the "degenerate workflow executor" for
 * `Reminder/v1` (doc 39 §Reminder). It does not interpret steps; a fire
 * just posts the reminder's notification. Snooze / Done apply the pure
 * transitions and persist them. Scheduling itself is the host's job (11b.6):
 * the host registers `configFor(reminder)` with the `SchedulerService`, and
 * on a due fire calls `fire(reminderId)`; on Snooze / Done it re-registers
 * (or unregisters) the reminder with the new config.
 *
 * Built against injected ports (a reminder store + the notify port), so it
 * is unit-testable with fakes and carries no broker / scheduler import.
 */

import type { ReminderDef } from "@brainstorm-os/sdk-types";
import {
	completeReminder,
	reminderNotification,
	reminderToTriggerConfig,
	snoozeReminder,
} from "./reminder-schedule";
import type { NotifyPort } from "./step-interpreters";
import type { TimeTriggerConfig } from "./trigger-schedule";

/** Load + persist a reminder by id — backed by the entities service. */
export type ReminderStore = {
	load(id: string): Promise<ReminderDef | null>;
	save(id: string, reminder: ReminderDef): Promise<void>;
};

export type ReminderRunnerPorts = {
	store: ReminderStore;
	notify: NotifyPort;
};

export class ReminderRunner {
	constructor(private readonly ports: ReminderRunnerPorts) {}

	/** The schedule the host registers with the `SchedulerService`, or `null`
	 *  when the reminder no longer fires (unregister). */
	configFor(reminder: ReminderDef): TimeTriggerConfig | null {
		return reminderToTriggerConfig(reminder);
	}

	/**
	 * Handle a due fire: load the reminder and post its notification.
	 * Returns `false` (no-op) when the reminder is gone or has been completed
	 * out from under the scheduler (a defensive guard against a stale fire);
	 * the scheduler is the primary gate on *when* this is called.
	 */
	async fire(reminderId: string): Promise<boolean> {
		const reminder = await this.ports.store.load(reminderId);
		if (!reminder) return false;
		if (reminderToTriggerConfig(reminder) === null) return false;
		await this.ports.notify(reminderNotification(reminder));
		return true;
	}

	/** Apply + persist the "Snooze" transition; the host re-registers the
	 *  returned reminder's `configFor`. Returns `null` if it is gone. */
	async snooze(reminderId: string, untilMs: number): Promise<ReminderDef | null> {
		const reminder = await this.ports.store.load(reminderId);
		if (!reminder) return null;
		const next = snoozeReminder(reminder, untilMs);
		await this.ports.store.save(reminderId, next);
		return next;
	}

	/** Apply + persist the "Done" transition; the host re-registers (recurring)
	 *  or unregisters (one-shot) via `configFor`. Returns `null` if gone. */
	async complete(reminderId: string, atMs: number): Promise<ReminderDef | null> {
		const reminder = await this.ports.store.load(reminderId);
		if (!reminder) return null;
		const next = completeReminder(reminder, atMs);
		await this.ports.store.save(reminderId, next);
		return next;
	}
}
