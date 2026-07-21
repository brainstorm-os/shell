/**
 * Browser-8 — per-site TRUST ("compatibility mode") for the locked web session.
 *
 * The strict privacy posture (Browser-2/4: third-party-cookie block + tracker
 * blocklist) is the DEFAULT and is never softened globally. Trusting an origin
 * is a per-site opt-in that relaxes both — for pages whose FIRST PARTY is that
 * origin — so login-gated SPAs (x.com etc.) whose SSO / scripts the strict
 * defaults break become usable, without giving up the default for every site.
 *
 * Decisions persist per vault at `<vaultPath>/shell/web-site-trust.json` (the
 * `site-permissions` convention). Only a `trusted: true` row is stored;
 * untrusting deletes it (absence = strict default). Pure core (store + codec +
 * read/write) — fully testable under Bun; the webRequest glue consults the sync
 * `isTrusted()` cache (Electron's request handlers can't await), fail-closed
 * (strict) while the file is still loading.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SiteTrustGrant } from "@brainstorm-os/protocol/web-privacy-wire-types";
import { webOriginOf } from "./site-permissions";

export const SITE_TRUST_FILENAME = "web-site-trust.json";

export function siteTrustPath(vaultPath: string): string {
	return join(vaultPath, "shell", SITE_TRUST_FILENAME);
}

function isValidGrant(input: unknown): input is SiteTrustGrant {
	if (!input || typeof input !== "object") return false;
	const raw = input as Record<string, unknown>;
	if (typeof raw.origin !== "string" || webOriginOf(raw.origin) !== raw.origin) return false;
	if (raw.trusted !== true) return false; // only trusted rows persist
	if (typeof raw.updatedAt !== "number" || !Number.isFinite(raw.updatedAt)) return false;
	return true;
}

/** Parse the persisted trust list, dropping malformed rows (a corrupt entry
 *  reverts to the strict default — the safe direction). */
export function parseSiteTrustGrants(input: unknown): SiteTrustGrant[] {
	if (!Array.isArray(input)) return [];
	return input.filter(isValidGrant);
}

/**
 * Pure per-origin trust store. `isTrusted(origin)` is a plain boolean (strict
 * default = false); a trusted origin relaxes the 3p-cookie strip + blocklist
 * for pages it is the first party of.
 */
export class SiteTrustStore {
	private readonly trusted = new Map<string, SiteTrustGrant>();

	constructor(seed: readonly SiteTrustGrant[] = []) {
		for (const grant of seed) if (grant.trusted) this.trusted.set(grant.origin, grant);
	}

	isTrusted(origin: string): boolean {
		return this.trusted.has(origin);
	}

	/** Trust (`trusted: true`) or untrust (`false`, which deletes the row) an
	 *  origin. Returns whether the set changed (for skip-persist). */
	set(origin: string, trusted: boolean, now: number): boolean {
		if (trusted) {
			this.trusted.set(origin, { origin, trusted: true, updatedAt: now });
			return true;
		}
		return this.trusted.delete(origin);
	}

	/** Drop the trust for `origin` (the Settings revoke affordance). */
	revokeOrigin(origin: string): boolean {
		return this.trusted.delete(origin);
	}

	list(): SiteTrustGrant[] {
		return [...this.trusted.values()].sort((a, b) => a.origin.localeCompare(b.origin));
	}
}

export async function readSiteTrustGrants(vaultPath: string): Promise<SiteTrustGrant[]> {
	try {
		const raw = await readFile(siteTrustPath(vaultPath), "utf8");
		return parseSiteTrustGrants(JSON.parse(raw));
	} catch {
		// Missing / unreadable / corrupt file ⇒ strict default for everything.
		return [];
	}
}

export async function writeSiteTrustGrants(
	vaultPath: string,
	grants: readonly SiteTrustGrant[],
): Promise<void> {
	const path = siteTrustPath(vaultPath);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(grants, null, 2)}\n`, "utf8");
}
