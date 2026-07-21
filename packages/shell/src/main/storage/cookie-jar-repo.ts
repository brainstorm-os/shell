/**
 * CookieJarRepository — CRUD on `cookies.db.cookies` (Browser-10).
 *
 * The persisted form of one web cookie. The whole DB is SQLCipher-encrypted
 * under a per-DB key derived from the vault master key, so values are
 * ciphertext at rest; this repo holds no crypto of its own. The Electron-side
 * jar (`web/web-cookie-jar.ts`) mirrors live partition cookies through here on
 * change and re-injects `listAll()` on vault open; the pure Electron ↔ record
 * mapping lives in `web/cookie-serde.ts`.
 */

import type { SqliteDatabase } from "@brainstorm-os/sqlite";

/** `SameSite` policy. Values are BOTH the persisted form AND Electron's
 *  `Cookie.sameSite` / `CookiesSetDetails.sameSite` wire strings — keep them
 *  identical so a round-trip needs no remapping. */
export enum SameSitePolicy {
	Unspecified = "unspecified",
	NoRestriction = "no_restriction",
	Lax = "lax",
	Strict = "strict",
}

const SAME_SITE_VALUES = new Set<string>(Object.values(SameSitePolicy));

/** Coerce an arbitrary persisted/Electron string to a known policy, defaulting
 *  to {@link SameSitePolicy.Unspecified} (Chromium's own default). */
export function toSameSitePolicy(value: string): SameSitePolicy {
	return SAME_SITE_VALUES.has(value) ? (value as SameSitePolicy) : SameSitePolicy.Unspecified;
}

/** One persisted cookie. `expiration` is Unix **seconds** (Electron's
 *  `expirationDate`); only non-session cookies (those with an expiry) are ever
 *  stored, so it is always present. The identity tuple is `(name, domain,
 *  path)` per RFC 6265. */
export type CookieRecord = {
	name: string;
	domain: string;
	path: string;
	value: string;
	hostOnly: boolean;
	secure: boolean;
	httpOnly: boolean;
	sameSite: SameSitePolicy;
	expiration: number;
};

/** The RFC 6265 identity of a cookie — what `cookies.on("changed")` removals
 *  and {@link CookieJarRepository.delete} key on. */
export type CookieKey = Pick<CookieRecord, "name" | "domain" | "path">;

type CookieRow = {
	name: string;
	domain: string;
	path: string;
	value: string;
	host_only: number;
	secure: number;
	http_only: number;
	same_site: string;
	expiration: number;
};

function rowToRecord(r: CookieRow): CookieRecord {
	return {
		name: r.name,
		domain: r.domain,
		path: r.path,
		value: r.value,
		hostOnly: r.host_only !== 0,
		secure: r.secure !== 0,
		httpOnly: r.http_only !== 0,
		sameSite: toSameSitePolicy(r.same_site),
		expiration: r.expiration,
	};
}

export class CookieJarRepository {
	constructor(private readonly db: SqliteDatabase) {}

	/** Insert or replace by identity tuple — the natural shape of a cookie
	 *  `changed` event (a re-set cookie keeps its `(name, domain, path)`). */
	upsert(cookie: CookieRecord): void {
		this.upsertStmt().run(
			cookie.name,
			cookie.domain,
			cookie.path,
			cookie.value,
			cookie.hostOnly ? 1 : 0,
			cookie.secure ? 1 : 0,
			cookie.httpOnly ? 1 : 0,
			cookie.sameSite,
			cookie.expiration,
		);
	}

	upsertMany(cookies: readonly CookieRecord[]): void {
		if (cookies.length === 0) return;
		this.db.transaction(() => {
			const stmt = this.upsertStmt();
			for (const c of cookies) {
				stmt.run(
					c.name,
					c.domain,
					c.path,
					c.value,
					c.hostOnly ? 1 : 0,
					c.secure ? 1 : 0,
					c.httpOnly ? 1 : 0,
					c.sameSite,
					c.expiration,
				);
			}
		})();
	}

	delete(key: CookieKey): void {
		this.db
			.prepare("DELETE FROM cookies WHERE name = ? AND domain = ? AND path = ?")
			.run(key.name, key.domain, key.path);
	}

	listAll(): CookieRecord[] {
		const rows = this.db
			.prepare(
				"SELECT name, domain, path, value, host_only, secure, http_only, same_site, expiration FROM cookies ORDER BY domain, path, name",
			)
			.all() as CookieRow[];
		return rows.map(rowToRecord);
	}

	/** Drop cookies whose expiry has passed (`expiration <= nowSeconds`).
	 *  Run on load so an expired jar isn't re-injected. Returns the count. */
	deleteExpired(nowSeconds: number): number {
		const result = this.db.prepare("DELETE FROM cookies WHERE expiration <= ?").run(nowSeconds);
		return Number(result.changes);
	}

	/** Wipe the jar (Settings → Privacy → Clear browsing data). Returns the
	 *  count removed. */
	clear(): number {
		const result = this.db.prepare("DELETE FROM cookies").run();
		return Number(result.changes);
	}

	private upsertStmt() {
		return this.db.prepare(
			"INSERT OR REPLACE INTO cookies (name, domain, path, value, host_only, secure, http_only, same_site, expiration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
	}
}
