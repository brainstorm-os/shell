/**
 * Per-device persistence for the calendar's source-filter visibility (9.15f).
 *
 * Backed by the `settings` service (device-local, vault-scoped — same posture
 * as `@brainstorm-os/sdk/last-viewed`), NOT localStorage: which sources you show
 * is a per-device view preference, not synced content. We persist the *hidden*
 * set so a newly discovered source (a new type, a new date property) defaults
 * to visible rather than silently absent. Best-effort throughout — a missing
 * service or a write race degrades to the defaults, never throws into render.
 */

import type { SettingsService } from "@brainstorm-os/sdk-types";
import { SOURCE_OVERRIDES } from "./scheduled-item";

const HIDDEN_SOURCES_KEY = "calendar.hidden-sources";

/** Sources hidden until the user opts them in (e.g. Task completion dates). */
export function defaultHiddenSources(): Set<string> {
	const out = new Set<string>();
	for (const [key, override] of Object.entries(SOURCE_OVERRIDES)) {
		if (override.defaultHidden) out.add(key);
	}
	return out;
}

/** The persisted hidden-source set, or the defaults when none stored / no
 *  service. */
export async function loadHiddenSources(
	settings: SettingsService | undefined,
): Promise<Set<string>> {
	if (!settings) return defaultHiddenSources();
	try {
		const raw = await settings.get<unknown>(HIDDEN_SOURCES_KEY);
		if (Array.isArray(raw)) {
			return new Set(raw.filter((k): k is string => typeof k === "string"));
		}
		return defaultHiddenSources();
	} catch {
		return defaultHiddenSources();
	}
}

/** Persist the hidden-source set. Swallows failures (device-local hint). */
export async function saveHiddenSources(
	settings: SettingsService | undefined,
	hidden: ReadonlySet<string>,
): Promise<void> {
	if (!settings) return;
	try {
		await settings.put(HIDDEN_SOURCES_KEY, [...hidden]);
	} catch {
		/* device-local convenience — never surface a failure here */
	}
}
