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
	accessRecordTampered,
	deriveAccessRoot,
	effectiveStatements,
	firstSightRoot,
	isAccessRole,
} from "./access-record";

/** Does the invite anchor on `grant` (a grant naming this identity) verify
 *  under this identity's own invite secret? */
export type AnchorVerifier = (entityId: string, grant: GrantStatement) => boolean;

/** What the store needs from storage — `AccessTrustRepository` in production,
 *  an in-memory map in tests. */
export type AccessTrustPersistence = {
	getRoot(entityId: string): string | null;
	pinRoot(entityId: string, rootPub: string, now: number): string;
	listStatements(entityId: string): AccessStatementRecord[];
	/** Returns how many of `records` could not be kept. */
	remember(
		entityId: string,
		records: readonly AccessStatementRecord[],
		now: number,
		rootPub: string,
	): number;
	getContainer(entityId: string): string | null;
	pinContainer(entityId: string, containerId: string, now: number): string;
	listContained(containerId: string): string[];
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
	readonly #warnedFull = new Set<string>();

	readonly #verifyAnchor: AnchorVerifier;

	constructor(
		persistence: AccessTrustPersistence,
		selfPubB64: string,
		options: { now?: () => number; verifyAnchor?: AnchorVerifier } = {},
	) {
		this.#persistence = persistence;
		this.#selfPubB64 = selfPubB64;
		this.#now = options.now ?? Date.now;
		this.#verifyAnchor = options.verifyAnchor ?? (() => false);
	}

	/**
	 * The root of a doc this device HOLDS but has no pin for - an entity that
	 * was here before 0.16, or one whose pin was lost.
	 *
	 *   1. Us, if we signed its genesis grant.
	 *   2. The root named by whoever INVITED us: a grant naming us whose invite
	 *      anchor verifies under our own invite secret is one only the party we
	 *      invited could have made, so it is believed over anything else in the
	 *      record - a second "root" someone added, or a lone impostor's.
	 *   3. With no such grant (we are the creator's other device, or the entity
	 *      came by a cascade), the ONE candidate that makes us a member - but
	 *      only if nothing was ever deleted from the record. A record with
	 *      deletions is not believed on its own say-so: it resolves nobody until
	 *      the genuine statements return (`recoverRoot`).
	 */
	#deriveRoot(doc: Y.Doc, entityId: string, memory: AccessMemory, fallback: boolean): string | null {
		const invited = firstSightRoot(
			doc,
			entityId,
			this.#selfPubB64,
			(grant) =>
				grant.addedBy === this.#selfPubB64 ||
				(grant.anchor !== null && this.#verifyAnchor(entityId, grant)),
		);
		if (invited !== null) return invited;
		if (!fallback || accessRecordTampered(doc)) return null;
		return deriveAccessRoot(doc, entityId, { self: this.#selfPubB64, memory });
	}

	/**
	 * Try to establish the root of an UNPINNED entity from `doc` using only
	 * evidence a collaborator cannot fabricate (rules 1-2 of the lazy pin), and
	 * pin it. This is the way back for a device left resolving nobody: the
	 * moment the true owner's statements reach it again - her device re-asserts
	 * them whenever tampering reaches her - the root is hers.
	 */
	recoverRoot(doc: Y.Doc, entityId: string): string | null {
		const pinned = this.#persistence.getRoot(entityId);
		if (pinned !== null) return pinned;
		const root = this.#deriveRoot(doc, entityId, this.memoryOf(entityId), false);
		return root === null ? null : this.pinRoot(entityId, root);
	}

	/** Pin the container `entityId` was first seen in (a cascade child). The
	 *  first pin is the only pin. */
	pinContainer(entityId: string, containerId: string): string {
		return this.#persistence.pinContainer(entityId, containerId, this.#now());
	}

	/** Every entity this device has pinned to `containerId`. */
	containedIn(containerId: string): string[] {
		return this.#persistence.listContained(containerId);
	}

	/**
	 * The container(s) whose membership also governs `entityId` — the CONTAINER
	 * RULE: a shared child is written, and re-keyed, only by a current Editor+
	 * of the container it lives in.
	 *
	 * The answer is this device's pin when it has one. Otherwise it is read from
	 * the `via` of the grants that have effect on the child (signed by its
	 * owners, and remembered here once seen): exactly one names the container
	 * and is pinned; several means the record disagrees with itself, and then
	 * ALL of them must admit the writer. It is never read from the child's own
	 * parent property, which its author can rewrite in the update being judged -
	 * so moving a message does not move who may write it. Empty for an entity
	 * that is not a cascade child.
	 */
	containersOf(
		doc: Y.Doc,
		entityId: string,
		trust: AccessTrust,
		/** The container this device's own row for the entity points at, when
		 *  that container is a shared one here (`container-rule.ts`). The last
		 *  resort for a child that predates `via` and pins - never exempt it. */
		structural: string | null = null,
	): string[] {
		const pinned = this.#persistence.getContainer(entityId);
		if (pinned !== null) return [pinned];
		const named = new Set<string>();
		if (trust.root !== null) {
			for (const grant of effectiveStatements(doc, entityId, trust).grants) {
				if (grant.via !== null) named.add(grant.via);
			}
		}
		if (named.size === 0 && structural !== null) named.add(structural);
		const containers = [...named].sort();
		const [only] = containers;
		if (containers.length === 1 && only !== undefined) this.pinContainer(entityId, only);
		return containers;
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
			const derived = this.#deriveRoot(doc, entityId, memory, true);
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
			fresh.push({
				kind: AccessStatementKind.Grant,
				sig: g.grantSig,
				body: JSON.stringify(g),
				signer: g.addedBy,
			});
		}
		for (const r of counted.revokes) {
			if (known.has(`${AccessStatementKind.Revoke}:${r.revokeSig}`)) continue;
			fresh.push({
				kind: AccessStatementKind.Revoke,
				sig: r.revokeSig,
				body: JSON.stringify(r),
				signer: r.revokedBy,
			});
		}
		if (fresh.length > 0) {
			// Revokes first: if anything is going to be refused for want of room,
			// it must not be the statement that removes someone.
			fresh.sort(
				(a, b) =>
					Number(b.kind === AccessStatementKind.Revoke) - Number(a.kind === AccessStatementKind.Revoke),
			);
			const dropped = this.#persistence.remember(entityId, fresh, this.#now(), root);
			if (dropped > 0 && !this.#warnedFull.has(entityId)) {
				this.#warnedFull.add(entityId);
				console.warn(
					`[sharing] ${entityId}: statement memory is full for a signer; ${dropped} statement(s) not remembered`,
				);
			}
		}
		// Everything fresh came out of `doc`, so `trust` already resolves it.
		return trust;
	}
}

/** A process-local persistence — for tests and the in-process collab harness,
 *  where there is no `entities.db` behind the docs. */
export function inMemoryAccessTrust(): AccessTrustPersistence {
	const roots = new Map<string, string>();
	const statements = new Map<string, Map<string, AccessStatementRecord>>();
	const containers = new Map<string, string>();
	return {
		getContainer: (entityId) => containers.get(entityId) ?? null,
		pinContainer: (entityId, containerId) => {
			const existing = containers.get(entityId);
			if (existing !== undefined) return existing;
			containers.set(entityId, containerId);
			return containerId;
		},
		listContained: (containerId) =>
			[...containers].filter(([, container]) => container === containerId).map(([id]) => id),
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
			return 0;
		},
	};
}
