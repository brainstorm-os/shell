/**
 * Reminder offsets (9.15.16) — thin bridge over the shared
 * `@brainstorm-os/sdk/reminder-schedule` (extracted at copy two when Tasks
 * adopted due/scheduled alerts, 9.14.9), keeping Calendar's established
 * import paths so consumers don't churn.
 */

export {
	REMINDER_PRESET_MINUTES,
	normalizeReminders,
	reminderInstant,
	toggleReminder,
} from "@brainstorm-os/sdk/reminder-schedule";
