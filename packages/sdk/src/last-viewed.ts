/**
 * last-viewed — the shared "reopen what I was looking at" primitive.
 *
 * Apps that show one primary object at a time (Books, Notes, the Database
 * detail pane, …) record the open entity id here on every selection change and
 * read it back at boot, so closing + reopening the app lands on the same place
 * instead of jumping to most-recent / default.
 *
 * Backed by the per-device `settings` service (NOT `localStorage`): it is
 * already namespaced by the verified app identity AND scoped to the active
 * vault session, so a last-viewed id from vault A can never bleed into vault B,
 * and the hint never syncs to other devices (a device-local cursor, which is
 * exactly right — "where I was reading" is per device). Replaces the per-app
 * `localStorage("<app>.lastOpenId")` pattern Notes shipped as a stopgap.
 *
 * Best-effort throughout: a preview/standalone shell without the settings
 * service, or a write race, is swallowed — the feature degrades to "open the
 * default" rather than throwing into a render path. The caller always
 * validates that the recalled id still resolves before navigating, so a
 * since-deleted target falls back to the app's default landing.
 */

import type { SettingsService } from "@brainstorm-os/sdk-types";

const DEFAULT_KEY = "last-viewed";

/** Record `id` as the app's current location (or clear it when `id` is null).
 *  `key` distinguishes multiple independent "locations" within one app (e.g. a
 *  split view); the common single-pane case takes the default. */
export async function rememberLastViewed(
	settings: SettingsService | undefined,
	id: string | null,
	key: string = DEFAULT_KEY,
): Promise<void> {
	if (!settings) return;
	try {
		if (id) await settings.put(key, id);
		else await settings.delete(key);
	} catch {
		/* device-local convenience hint — never surface a failure here */
	}
}

/** The entity id the app last recorded, or `null` when none / unavailable. */
export async function recallLastViewed(
	settings: SettingsService | undefined,
	key: string = DEFAULT_KEY,
): Promise<string | null> {
	if (!settings) return null;
	try {
		const id = await settings.get<string>(key);
		return typeof id === "string" && id.length > 0 ? id : null;
	} catch {
		return null;
	}
}
