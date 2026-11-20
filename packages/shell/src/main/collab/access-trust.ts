/**
 * AccessTrustStore — this device's side of the sharing authorization policy
 * (0.16.0; the policy itself is `access-record.ts`).
 *
 * The access record lives in the entity's own doc, which every member can
 * write. Two facts about it must therefore come from somewhere a collaborator
 * cannot reach, and this is where:
 *
 *   - the ROOT OWNER, pinned the first time this device resolves the record
 *     and never replaced. On the device that created the record the root is
 *     this identity (it signed the genesis grant). On a device that received
 *     the entity, it is pinned by the share-bootstrap gate from the record the
 *     inviter sent - trust on first use from whoever handed us the DEK - and,
 *     for an entity that was already here before 0.16, from the persisted doc
 *     the first time it is read.
 *   - the MEMORY of signed statements seen to take effect, so that deleting a
 *     grant or a revoke from the doc's array changes nothing on this device.
 *
 * Every production reader of a persisted record goes through {@link trustFor}.
 */

import type * as Y from "yjs";
import {
	AccessStatementKind,
	type AccessStatementRecord,
} from "../storage/entities-repo/access-trust-repo";
import {
	type AccessMemory,
	type AccessTrust,
	type GrantStatement,
	type RevokeStatement,
	deriveAccessRoot,
	effectiveStatements,
	isAccessRole,
} from "./access-record";

/** What the store needs from storage — `AccessTrustRepository` in production,
 *  an in-memory map in tests. */
export type AccessTrustPersistence = {
	getRoot(entityId: string): string | null;
	pinRoot(entityId: string, rootPub: string, now: number): string;
	listStatements(entityId: string): AccessStatementRecord[];
	remember(entityId: string, records: readonly AccessStatementRecord[], now: number): void;
};

function parseGrant(body: string): GrantStatement | null {
	try {
		const v = JSON.parse(body) as Partial<GrantStatement>;
		if (typeof v.member !== "string" || typeof v.addedBy !== "string") return null;
		if (typeof v.addedAt !== "number" || typeof v.grantSig !== "string") return null;
		if (!isAccessRole(v.role)) return null;
		return {
			member: v.member,
			x25519: typeof v.x25519 === "string" ? v.x25519 : null,
			anchor: typeof v.anchor === "string" ? v.anchor : null,
			via: typeof v.via === "string" ? v.via : null,
			role: v.role,
			addedBy: v.addedBy,
			addedAt: v.addedAt,
			grantSig: v.grantSig,
		};
	} catch {
		return null;
	}
}

function parseRevoke(body: string): RevokeStatement | null {
	try {
		const v = JSON.parse(body) as Partial<RevokeStatement>;
		if (typeof v.member !== "string" || typeof v.revokedBy !== "string") return null;
		if (typeof v.addedAt !== "number" || typeof v.revokedAt !== "number") return null;
		if (typeof v.revokeSig !== "string") return null;
		return {
			member: v.member,
			addedAt: v.addedAt,
			revokedAt: v.revokedAt,
			revokedBy: v.revokedBy,
			revokeSig: v.revokeSig,
		};
	} catch {
		return null;
	}
}

export class AccessTrustStore {
	readonly #persistence: AccessTrustPersistence;
	readonly #selfPubB64: string;
	readonly #now: () => number;

	constructor(
		persistence: AccessTrustPersistence,
		selfPubB64: string,
		now: () => number = Date.now,
	) {
		this.#persistence = persistence;
		this.#selfPubB64 = selfPubB64;
		this.#now = now;
	}

	/** What this device remembers of `entityId`'s record. Every remembered
	 *  statement is re-verified by the policy on each resolve, so a corrupted
	 *  row can only ever drop out. */
	memoryOf(entityId: string): AccessMemory {
		const grants: GrantStatement[] = [];
		const revokes: RevokeStatement[] = [];
		for (const record of this.#persistence.listStatements(entityId)) {
			if (record.kind === AccessStatementKind.Grant) {
				const grant = parseGrant(record.body);
				if (grant) grants.push(grant);
			} else {
				const revoke = parseRevoke(record.body);
				if (revoke) revokes.push(revoke);
			}
		}
		return { grants, revokes };
	}

	/** The root owner pinned for `entityId`, or null when none is yet. */
	rootOf(entityId: string): string | null {
		return this.#persistence.getRoot(entityId);
	}

	/** Pin `rootPub` as `entityId`'s root owner. The first pin is the only pin;
	 *  returns the root actually in force. */
	pinRoot(entityId: string, rootPub: string): string {
		return this.#persistence.pinRoot(entityId, rootPub, this.#now());
	}

	/**
	 * The trust to resolve `entityId`'s PERSISTED doc with. Pins the root if
	 * this is the first time the record singles one out, and remembers every
	 * statement that currently has effect.
	 *
	 * Never call this on a doc that has not been admitted yet (a bootstrap
	 * probe): it would pin a root from, and remember statements out of, bytes
	 * nobody has authorized. The bootstrap gate derives an unpinned trust and
	 * pins through {@link pinRoot} only once it has allowed the frame.
	 */
	trustFor(doc: Y.Doc, entityId: string): AccessTrust {
		const memory = this.memoryOf(entityId);
		let root = this.#persistence.getRoot(entityId);
		if (root === null) {
			const derived = deriveAccessRoot(doc, entityId, { self: this.#selfPubB64, memory });
			if (derived !== null) root = this.pinRoot(entityId, derived);
		}
		const trust: AccessTrust = { root, memory };
		if (root === null) return trust;
		const counted = effectiveStatements(doc, entityId, trust);
		const known = new Set<string>();
		for (const g of memory.grants) known.add(`${AccessStatementKind.Grant}:${g.grantSig}`);
		for (const r of memory.revokes) known.add(`${AccessStatementKind.Revoke}:${r.revokeSig}`);
		const fresh: AccessStatementRecord[] = [];
		for (const g of counted.grants) {
			if (known.has(`${AccessStatementKind.Grant}:${g.grantSig}`)) continue;
			fresh.push({ kind: AccessStatementKind.Grant, sig: g.grantSig, body: JSON.stringify(g) });
		}
		for (const r of counted.revokes) {
			if (known.has(`${AccessStatementKind.Revoke}:${r.revokeSig}`)) continue;
			fresh.push({ kind: AccessStatementKind.Revoke, sig: r.revokeSig, body: JSON.stringify(r) });
		}
		if (fresh.length > 0) this.#persistence.remember(entityId, fresh, this.#now());
		// Everything fresh came out of `doc`, so `trust` already resolves it.
		return trust;
	}
}

/** A process-local persistence — for tests and the in-process collab harness,
 *  where there is no `entities.db` behind the docs. */
export function inMemoryAccessTrust(): AccessTrustPersistence {
	const roots = new Map<string, string>();
	const statements = new Map<string, Map<string, AccessStatementRecord>>();
	return {
		getRoot: (entityId) => roots.get(entityId) ?? null,
		pinRoot: (entityId, rootPub) => {
			const existing = roots.get(entityId);
			if (existing !== undefined) return existing;
			roots.set(entityId, rootPub);
			return rootPub;
		},
		listStatements: (entityId) => [...(statements.get(entityId)?.values() ?? [])],
		remember: (entityId, records) => {
			const forEntity = statements.get(entityId) ?? new Map<string, AccessStatementRecord>();
			for (const record of records) {
				const key = `${record.kind}:${record.sig}`;
				if (!forEntity.has(key)) forEntity.set(key, record);
			}
			statements.set(entityId, forEntity);
		},
	};
}
