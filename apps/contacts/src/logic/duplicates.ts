/**
 * Duplicate detection + merge planning (F-158). Pure logic — no DOM, no
 * services — unit-tested in isolation.
 *
 * Detection: two people sharing a normalized EMAIL are a strong match; two
 * people sharing a normalized FULL NAME are a candidate match. Evidence is
 * unioned (union-find), so "7× Dana Whitfield, 3 of them sharing an address"
 * is ONE group, graded by its strongest evidence. Unnamed people and empty
 * emails never match — an abandoned ghost row must not glue real people
 * together.
 *
 * Merge planning: field-level union INTO the chosen survivor. Multi-value
 * fields (emails / phones / related-people links) union with de-dupe; scalar
 * fields fill only when the survivor's slot is empty — a conflict keeps the
 * survivor's value (the loser's emails/phones still ride along in the union,
 * so nothing contact-critical is lost). The shell's `entities.merge` then
 * repoints links + refs and bins the losers.
 */

import type { Person, VaultEntityLike } from "../types/person";

export enum DuplicateMatchKind {
	/** Same normalized email — strong. */
	Email = "email",
	/** Same normalized full name only — candidate. */
	Name = "name",
}

export type DuplicateGroup = {
	/** Member ids, default-survivor first (most complete, then oldest). */
	ids: string[];
	kind: DuplicateMatchKind;
};

/** Case-fold + trim. An empty result never matches. */
export function normalizeEmail(raw: string): string {
	return raw.trim().toLowerCase();
}

/** Case-fold, collapse inner whitespace, strip diacritics — so
 *  "Dana  Whitfield" / "dana whitfield" / "Dána Whitfield" all key equal.
 *  An empty result never matches. */
export function normalizeFullName(raw: string): string {
	return raw
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.trim()
		.replace(/\s+/gu, " ")
		.toLocaleLowerCase();
}

/** Digits (+ leading plus) only, for phone de-dupe: "+1 555-0100" ≡ "15550100"
 *  is NOT assumed — only formatting characters fold, the digit string must
 *  match exactly. */
function normalizePhone(raw: string): string {
	return raw.replace(/[^\d+]/gu, "");
}

/** How filled-in a person is — the default-survivor ranking axis. */
export function completenessScore(person: Person): number {
	let score = 0;
	if (person.name) score += 1;
	if (person.role) score += 1;
	if (person.bio) score += 1;
	if (person.companyId) score += 1;
	if (person.birthday !== null) score += 1;
	if (person.anniversary !== null) score += 1;
	score += person.emails.length + person.phones.length + person.linkIds.length;
	return score;
}

type UnionFind = Map<string, string>;

function findRoot(uf: UnionFind, id: string): string {
	let root = id;
	while (uf.get(root) !== root) root = uf.get(root) ?? root;
	// Path compression.
	let cur = id;
	while (cur !== root) {
		const next = uf.get(cur) ?? root;
		uf.set(cur, root);
		cur = next;
	}
	return root;
}

function union(uf: UnionFind, a: string, b: string): void {
	uf.set(findRoot(uf, a), findRoot(uf, b));
}

/**
 * Group probable duplicates. `createdAtOf` breaks completeness ties toward
 * the OLDEST record (the one other data has been pointing at longest).
 * Groups are ordered largest-first, then by member name, so the worst
 * offenders ("7× Dana Whitfield") lead the review list.
 */
export function findDuplicateGroups(
	persons: readonly Person[],
	createdAtOf: (id: string) => number = () => 0,
): DuplicateGroup[] {
	const byId = new Map(persons.map((p) => [p.id, p]));
	const uf: UnionFind = new Map(persons.map((p) => [p.id, p.id]));

	const emailBuckets = new Map<string, string[]>();
	const nameBuckets = new Map<string, string[]>();
	for (const person of persons) {
		for (const email of person.emails) {
			const key = normalizeEmail(email);
			if (!key) continue;
			const bucket = emailBuckets.get(key);
			if (bucket) {
				if (!bucket.includes(person.id)) bucket.push(person.id);
			} else emailBuckets.set(key, [person.id]);
		}
		const nameKey = normalizeFullName(person.name);
		if (nameKey) {
			const bucket = nameBuckets.get(nameKey);
			if (bucket) bucket.push(person.id);
			else nameBuckets.set(nameKey, [person.id]);
		}
	}

	for (const bucket of [...emailBuckets.values(), ...nameBuckets.values()]) {
		const first = bucket[0];
		if (!first || bucket.length < 2) continue;
		for (const id of bucket) union(uf, first, id);
	}

	// A component is STRONG when any email bucket contributed a union to it.
	const strongRoots = new Set<string>();
	for (const bucket of emailBuckets.values()) {
		const first = bucket[0];
		if (first && bucket.length >= 2) strongRoots.add(findRoot(uf, first));
	}

	const components = new Map<string, string[]>();
	for (const person of persons) {
		const root = findRoot(uf, person.id);
		const members = components.get(root);
		if (members) members.push(person.id);
		else components.set(root, [person.id]);
	}

	const rank = (id: string): [number, number, string] => {
		const person = byId.get(id);
		return [person ? -completenessScore(person) : 0, createdAtOf(id), id];
	};

	const groups: DuplicateGroup[] = [];
	for (const [root, ids] of components) {
		if (ids.length < 2) continue;
		const ordered = [...ids].sort((a, b) => {
			const ra = rank(a);
			const rb = rank(b);
			if (ra[0] !== rb[0]) return ra[0] - rb[0];
			if (ra[1] !== rb[1]) return ra[1] - rb[1];
			return ra[2] < rb[2] ? -1 : 1;
		});
		groups.push({
			ids: ordered,
			kind: strongRoots.has(root) ? DuplicateMatchKind.Email : DuplicateMatchKind.Name,
		});
	}
	return groups.sort((a, b) => {
		if (a.ids.length !== b.ids.length) return b.ids.length - a.ids.length;
		const an = byId.get(a.ids[0] ?? "")?.name ?? "";
		const bn = byId.get(b.ids[0] ?? "")?.name ?? "";
		return an.localeCompare(bn);
	});
}

/**
 * The field-level union the survivor receives. Only changed keys appear —
 * an empty object means the survivor already carries everything. Conflicting
 * scalars keep the survivor's value; multi-value fields union (normalized
 * de-dupe, survivor's entries first, original formatting kept). Related-
 * people links drop refs to group members — those collapse into the survivor
 * itself.
 */
export function planMergePatch(
	survivor: Person,
	losers: readonly Person[],
): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	const memberIds = new Set([survivor.id, ...losers.map((l) => l.id)]);

	const unionMulti = (
		own: readonly string[],
		of: (p: Person) => readonly string[],
		normalize: (s: string) => string,
	): string[] | null => {
		const seen = new Set(own.map(normalize));
		const out = [...own];
		for (const loser of losers) {
			for (const value of of(loser)) {
				const key = normalize(value);
				if (!key || seen.has(key)) continue;
				seen.add(key);
				out.push(value);
			}
		}
		return out.length !== own.length ? out : null;
	};

	const emails = unionMulti(survivor.emails, (p) => p.emails, normalizeEmail);
	if (emails) patch.email = emails;
	const phones = unionMulti(survivor.phones, (p) => p.phones, normalizePhone);
	if (phones) patch.phone = phones;

	const firstLoser = <T>(pick: (p: Person) => T | null | ""): T | null => {
		for (const loser of losers) {
			const value = pick(loser);
			if (value !== null && value !== "") return value as T;
		}
		return null;
	};

	if (!survivor.name) {
		const name = firstLoser((p) => p.name);
		if (name) patch.name = name;
	}
	if (!survivor.role) {
		const role = firstLoser((p) => p.role);
		if (role) patch.role = role;
	}
	if (!survivor.bio) {
		const bio = firstLoser((p) => p.bio);
		if (bio) patch.bio = bio;
	}
	if (!survivor.companyId) {
		const company = firstLoser((p) => p.companyId);
		if (company) patch.company = company;
	}
	if (survivor.birthday === null) {
		const birthday = firstLoser((p) => p.birthday);
		if (birthday !== null) patch.birthday = birthday;
	}
	if (survivor.anniversary === null) {
		const anniversary = firstLoser((p) => p.anniversary);
		if (anniversary !== null) patch.anniversary = anniversary;
	}

	const links = new Set(survivor.linkIds);
	for (const loser of losers) for (const id of loser.linkIds) links.add(id);
	for (const id of memberIds) links.delete(id);
	const linkList = [...links];
	if (
		linkList.length !== survivor.linkIds.length ||
		linkList.some((id, i) => survivor.linkIds[i] !== id)
	) {
		patch.links = linkList;
	}

	return patch;
}

/** Rewrite one demo property value: loser ids → survivor (drop self-refs +
 *  duplicates). Mirrors the shell-side `rewriteEntityRefs` for the in-memory
 *  demo vault only — the shell operation is authoritative in vault mode. */
function rewriteDemoValue(
	value: unknown,
	losers: ReadonlySet<string>,
	survivorId: string,
	selfId: string,
): unknown {
	if (typeof value === "string") {
		if (!losers.has(value)) return value;
		return survivorId === selfId ? null : survivorId;
	}
	if (Array.isArray(value)) {
		const out: unknown[] = [];
		const seen = new Set<string>();
		for (const item of value) {
			const rewritten = rewriteDemoValue(item, losers, survivorId, selfId);
			if (rewritten === null && item !== null) continue;
			const id = typeof rewritten === "string" ? rewritten : null;
			if (id) {
				if (seen.has(id)) continue;
				seen.add(id);
			}
			out.push(rewritten);
		}
		return out;
	}
	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		for (const key of ["value", "id", "entityId"]) {
			const inner = obj[key];
			if (typeof inner === "string" && losers.has(inner)) {
				if (survivorId === selfId) return null;
				return { ...obj, [key]: survivorId };
			}
		}
	}
	return value;
}

/**
 * Demo-mode merge: apply the patch to the survivor, repoint every remaining
 * entity's refs, drop the losers. Vault mode goes through the shell's
 * `entities.merge` instead.
 */
export function applyMergeToEntities(
	entities: readonly VaultEntityLike[],
	survivorId: string,
	loserIds: readonly string[],
	patch: Record<string, unknown>,
): VaultEntityLike[] {
	const losers = new Set(loserIds);
	losers.delete(survivorId);
	const out: VaultEntityLike[] = [];
	for (const entity of entities) {
		if (losers.has(entity.id)) continue;
		let properties = entity.properties;
		if (entity.id === survivorId) properties = { ...properties, ...patch };
		const rewritten: Record<string, unknown> = {};
		let changed = false;
		for (const [key, value] of Object.entries(properties)) {
			const next = rewriteDemoValue(value, losers, survivorId, entity.id);
			rewritten[key] = next;
			if (next !== value) changed = true;
		}
		out.push(entity.id === survivorId || changed ? { ...entity, properties: rewritten } : entity);
	}
	return out;
}

/** Everything the review dialog needs about one group, resolved. */
export type DuplicateGroupView = {
	group: DuplicateGroup;
	persons: Person[];
	defaultSurvivorId: string;
};

/** Resolve groups to their `Person` view-models (dropping any id that fell
 *  out of the snapshot between detection and render). */
export function resolveGroups(
	groups: readonly DuplicateGroup[],
	persons: readonly Person[],
): DuplicateGroupView[] {
	const byId = new Map(persons.map((p) => [p.id, p]));
	const out: DuplicateGroupView[] = [];
	for (const group of groups) {
		const members = group.ids.map((id) => byId.get(id)).filter((p): p is Person => p !== undefined);
		const first = members[0];
		if (members.length < 2 || !first) continue;
		out.push({ group, persons: members, defaultSurvivorId: first.id });
	}
	return out;
}
