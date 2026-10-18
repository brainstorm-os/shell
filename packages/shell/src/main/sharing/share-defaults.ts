/**
 * Collab-C7 — the role a NEW share starts at. A per-vault preference in the
 * shell's own `settings.db` namespace (apps cannot reach it — the settings
 * service stamps the broker-verified app id). Only Viewer / Editor are
 * representable; anything else, or nothing stored, reads as Viewer: a share is
 * read-only until the owner deliberately widens it.
 */

import {
	DEFAULT_SHARE_ROLE,
	type RosterRole,
	parseShareDefaultRole,
} from "@brainstorm-os/sdk-types";
import type { SettingsRepository } from "../storage/settings-repo";

const SHELL_SETTINGS_APP_ID = "io.brainstorm.shell";
const DEFAULT_ROLE_KEY = "sharing.defaultRole";

export function readDefaultShareRole(repo: SettingsRepository | null): RosterRole {
	if (!repo) return DEFAULT_SHARE_ROLE;
	const raw = repo.get(SHELL_SETTINGS_APP_ID, DEFAULT_ROLE_KEY);
	if (raw === null) return DEFAULT_SHARE_ROLE;
	try {
		return parseShareDefaultRole(JSON.parse(raw));
	} catch {
		return DEFAULT_SHARE_ROLE;
	}
}

/** Persist `role` when it is a permitted default; returns what is now in
 *  effect (fail-closed to the stored value on anything else). */
export function writeDefaultShareRole(repo: SettingsRepository | null, role: unknown): RosterRole {
	if (!repo) return DEFAULT_SHARE_ROLE;
	const parsed = parseShareDefaultRole(role);
	if (parsed !== role) return readDefaultShareRole(repo);
	repo.set(SHELL_SETTINGS_APP_ID, DEFAULT_ROLE_KEY, JSON.stringify(parsed));
	return parsed;
}
