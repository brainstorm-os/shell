/** IE-14 — how often the scheduled backup runs. Shared by the main-process
 *  scheduler, the preload bridge types and the Settings panel. */
export enum BackupFrequency {
	Off = "off",
	Daily = "daily",
	Weekly = "weekly",
}
