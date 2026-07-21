/**
 * Browser-7 — per-site device-permission grants for the locked web session.
 *
 * Deny-default stands (Browser-2): a page request for camera / microphone /
 * geolocation resolves `false` unless the user explicitly allowed that
 * origin+kind. Decisions persist per vault at
 * `<vaultPath>/shell/web-site-permissions.json` (the
 * `vault-network-settings-store` convention) so a grant survives relaunch;
 * everything **not** in {@link SitePermissionKind} stays deny-always and is
 * never persisted or surfaced.
 *
 * Pure core (`SitePermissionStore` + codec + the Electron-string mapping) —
 * fully testable under Bun. The Electron glue consults the store through the
 * sync `decision()` cache (Electron's `setPermissionCheckHandler` is sync);
 * fail-closed while the file is still loading.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SitePermissionKind } from "@brainstorm-os/sdk-types";
import type { SitePermissionGrant } from "../../web-privacy-wire-types";

export const SITE_PERMISSIONS_FILENAME = "web-site-permissions.json";

export function sitePermissionsPath(vaultPath: string): string {
	return join(vaultPath, "shell", SITE_PERMISSIONS_FILENAME);
}

const KIND_VALUES = new Set<string>(Object.values(SitePermissionKind));

/**
 * Map an Electron permission request onto the grantable kinds. `media`
 * fans out per `mediaTypes` (a camera+mic call needs both grants);
 * anything unrecognised maps to `[]` = deny-always, not grantable.
 */
export function sitePermissionKindsFor(
	permission: string,
	mediaTypes?: readonly string[],
): SitePermissionKind[] {
	if (permission === "geolocation") return [SitePermissionKind.Geolocation];
	if (permission === "media") {
		const kinds: SitePermissionKind[] = [];
		const types = mediaTypes ?? [];
		if (types.includes("video")) kinds.push(SitePermissionKind.Camera);
		if (types.includes("audio")) kinds.push(SitePermissionKind.Microphone);
		return kinds;
	}
	return [];
}

/** Serialized web origin for a page URL, or `null` for anything that isn't a
 *  plain http(s) page (no grants on about:/blob:/custom schemes). */
export function webOriginOf(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		return parsed.origin;
	} catch {
		return null;
	}
}

function isValidGrant(input: unknown): input is SitePermissionGrant {
	if (!input || typeof input !== "object") return false;
	const raw = input as Record<string, unknown>;
	if (typeof raw.origin !== "string" || webOriginOf(raw.origin) !== raw.origin) return false;
	if (typeof raw.permission !== "string" || !KIND_VALUES.has(raw.permission)) return false;
	if (typeof raw.allow !== "boolean") return false;
	if (typeof raw.updatedAt !== "number" || !Number.isFinite(raw.updatedAt)) return false;
	return true;
}

/** Parse the persisted grant list, dropping malformed rows (a corrupt entry
 *  must not poison the rest — the dropped row reverts to deny-default, the
 *  safe direction). */
export function parseSitePermissionGrants(input: unknown): SitePermissionGrant[] {
	if (!Array.isArray(input)) return [];
	return input.filter(isValidGrant);
}

function grantKey(origin: string, permission: SitePermissionKind): string {
	return `${origin}\u0000${permission}`;
}

/**
 * Pure origin+kind decision store. `decision()` is tri-state: `true` =
 * explicit allow, `false` = explicit block (the chrome stops asking),
 * `null` = unset (deny + the chrome may ask).
 */
export class SitePermissionStore {
	private readonly grants = new Map<string, SitePermissionGrant>();

	constructor(seed: readonly SitePermissionGrant[] = []) {
		for (const grant of seed) this.grants.set(grantKey(grant.origin, grant.permission), grant);
	}

	decision(origin: string, permission: SitePermissionKind): boolean | null {
		return this.grants.get(grantKey(origin, permission))?.allow ?? null;
	}

	/** Fail-closed boolean view of {@link decision} for the permission glue. */
	isAllowed(origin: string, permission: SitePermissionKind): boolean {
		return this.decision(origin, permission) === true;
	}

	set(origin: string, permission: SitePermissionKind, allow: boolean, now: number): void {
		this.grants.set(grantKey(origin, permission), { origin, permission, allow, updatedAt: now });
	}

	/** Drop every decision for `origin` (the Settings revoke affordance). */
	revokeOrigin(origin: string): boolean {
		let removed = false;
		for (const [key, grant] of this.grants) {
			if (grant.origin === origin) {
				this.grants.delete(key);
				removed = true;
			}
		}
		return removed;
	}

	list(): SitePermissionGrant[] {
		return [...this.grants.values()].sort(
			(a, b) => a.origin.localeCompare(b.origin) || a.permission.localeCompare(b.permission),
		);
	}
}

export async function readSitePermissionGrants(vaultPath: string): Promise<SitePermissionGrant[]> {
	try {
		const raw = await readFile(sitePermissionsPath(vaultPath), "utf8");
		return parseSitePermissionGrants(JSON.parse(raw));
	} catch {
		// Missing / unreadable / corrupt file ⇒ deny-default for everything.
		return [];
	}
}

export async function writeSitePermissionGrants(
	vaultPath: string,
	grants: readonly SitePermissionGrant[],
): Promise<void> {
	const path = sitePermissionsPath(vaultPath);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(grants, null, 2)}\n`, "utf8");
}
