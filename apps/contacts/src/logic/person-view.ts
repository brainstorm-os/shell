/**
 * Pure projection + presentation logic for the people list. Maps a
 * `Person/v1` entity property bag into the typed `Person` view-model, and
 * derives the list's grouping / search / ordering. No DOM, no services —
 * unit-tested in isolation.
 */

import { PERSON_TYPE, type Person, type VaultEntityLike } from "../types/person";

/** Normalise a stored multi-value text property (email / phone) into a
 *  clean `string[]`. Tolerates the three shapes a value can arrive in: a
 *  bare string, a `string[]`, or an array of `{ value }` / `{ label }`
 *  envelopes the property-ui cells may emit. Blanks are dropped. */
export function toStringArray(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : value == null ? [] : [value];
	const out: string[] = [];
	for (const item of raw) {
		const s =
			typeof item === "string"
				? item
				: typeof item === "object" && item !== null
					? str((item as Record<string, unknown>).value) || str((item as Record<string, unknown>).label)
					: "";
		const trimmed = s.trim();
		if (trimmed) out.push(trimmed);
	}
	return out;
}

/** Resolve a single entity-ref value to an id. An EntityRef can be stored
 *  as a bare id string, a `{ id }` / `{ value }` / `{ entityId }` envelope,
 *  or (for a single-value ref) a one-element array of any of those. */
export function refToId(value: unknown): string | null {
	if (Array.isArray(value)) return value.length > 0 ? refToId(value[0]) : null;
	if (typeof value === "string") return value.trim() || null;
	if (typeof value === "object" && value !== null) {
		const o = value as Record<string, unknown>;
		return str(o.id) || str(o.entityId) || str(o.value) || null;
	}
	return null;
}

/** Resolve a multi-value entity-ref to its list of ids (dedup, order-kept). */
export function refsToIds(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : value == null ? [] : [value];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of raw) {
		const id = refToId(item);
		if (id && !seen.has(id)) {
			seen.add(id);
			out.push(id);
		}
	}
	return out;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function num(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Project a vault entity into the `Person` view-model. */
export function entityToPerson(entity: VaultEntityLike): Person {
	const p = entity.properties;
	return {
		id: entity.id,
		name: str(p.name).trim(),
		emails: toStringArray(p.email),
		phones: toStringArray(p.phone),
		companyId: refToId(p.company),
		role: str(p.role).trim(),
		birthday: num(p.birthday),
		anniversary: num(p.anniversary),
		linkIds: refsToIds(p.links),
		bio: str(p.bio),
	};
}

/** Every `Person/v1` row in a vault snapshot, projected + name-sorted. */
export function personsFromEntities(entities: readonly VaultEntityLike[]): Person[] {
	return entities
		.filter((e) => e.type === PERSON_TYPE)
		.map(entityToPerson)
		.sort(comparePersons);
}

/** Initials for the avatar — first letter of the first and last words,
 *  upper-cased. Only letters/digits may land in the chip: a word that opens
 *  with punctuation ("Ada Lovelace (work)", 'Ada "Countess" Lovelace') is
 *  decoration and is skipped outright — the old first-char-of-last-word rule
 *  put a literal "(" in the avatar. If NO word opens with a letter/digit the
 *  first letter/digit found anywhere is the fallback ("(Ada)" → "A"). Empty
 *  string for an unnamed person (the caller renders a neutral glyph). */
export function personInitials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	const leading = words.filter((w) => /^[\p{L}\p{N}]/u.test(w)).map((w) => w[0] ?? "");
	const pool =
		leading.length > 0
			? leading
			: words.map((w) => w.match(/[\p{L}\p{N}]/u)?.[0] ?? "").filter(Boolean);
	if (pool.length === 0) return "";
	const first = pool[0] ?? "";
	const second = pool.length > 1 ? (pool[pool.length - 1] ?? "") : "";
	return (first + second).toUpperCase();
}

/** How the people list sections itself. `FirstLetter` is the default
 *  address-book chronology; the rest re-section the SAME filtered set along a
 *  different Person axis. The sidebar exposes this as a "Group by ▾" picker. */
export enum ContactsGrouping {
	FirstLetter = "first-letter",
	Company = "company",
	Role = "role",
	None = "none",
}

/** All grouping axes in the order the "Group by" picker lists them. */
export const CONTACTS_GROUPINGS: readonly ContactsGrouping[] = Object.freeze([
	ContactsGrouping.FirstLetter,
	ContactsGrouping.Company,
	ContactsGrouping.Role,
	ContactsGrouping.None,
]);

/** How the people list orders within a group. Only axes backed by an existing
 *  `Person` field — there is no `createdAt`, so no "date added". */
export enum ContactsSorting {
	Name = "name",
	Company = "company",
}

/** All sort axes in the order the "Sort by ▾" picker lists them. */
export const CONTACTS_SORTINGS: readonly ContactsSorting[] = Object.freeze([
	ContactsSorting.Name,
	ContactsSorting.Company,
]);

/** Resolvers the generic groupers / comparators need to render Person refs as
 *  the names the user sees. `companyName` returns null for a missing / unset
 *  company, which routes the person into the trailing "No company" bucket. */
export type PersonViewResolvers = {
	companyName: (id: string | null) => string | null;
};

/** Sort by name (locale-aware, case-insensitive); unnamed people sink to the
 *  bottom; ties break on id so the order is stable. */
export function comparePersons(a: Person, b: Person): number {
	const an = a.name.toLocaleLowerCase();
	const bn = b.name.toLocaleLowerCase();
	if (!an && bn) return 1;
	if (an && !bn) return -1;
	const byName = an.localeCompare(bn);
	return byName !== 0 ? byName : a.id.localeCompare(b.id);
}

/** Compare two people along the chosen sort axis. `Name` is `comparePersons`;
 *  `Company` orders by resolved company name (people with no company sink to
 *  the bottom), then breaks ties on name. */
export function comparePersonsBy(
	a: Person,
	b: Person,
	sort: ContactsSorting,
	resolvers: PersonViewResolvers,
): number {
	if (sort === ContactsSorting.Company) {
		const ac = (resolvers.companyName(a.companyId) ?? "").toLocaleLowerCase();
		const bc = (resolvers.companyName(b.companyId) ?? "").toLocaleLowerCase();
		if (!ac && bc) return 1;
		if (ac && !bc) return -1;
		const byCompany = ac.localeCompare(bc);
		if (byCompany !== 0) return byCompany;
	}
	return comparePersons(a, b);
}

/** The bucket letter for a person — the upper-cased first letter of the name,
 *  or a shared "other" bucket for empty / non-alphabetic starts. */
export function groupLetter(person: Person, otherLabel: string): string {
	const ch = person.name.trim()[0];
	if (!ch) return otherLabel;
	const upper = ch.toLocaleUpperCase();
	return /\p{L}/u.test(upper) ? upper : otherLabel;
}

export type PersonGroup = { letter: string; persons: Person[] };

/** A rendered group of people. `label` is the already-localized heading the UI
 *  prints verbatim (a first-letter, a company name, a role). `trailing` marks
 *  the catch-all bucket (the "other" letter / "No company" / "No role") so it
 *  always sorts last. `none` groups carry an empty label and the UI suppresses
 *  the heading entirely. */
export type PersonGroupView = {
	key: string;
	label: string;
	trailing: boolean;
	persons: Person[];
};

/** Group a name-sorted person list into alphabetic buckets. The "other"
 *  bucket (digits / symbols / unnamed) always sorts last. */
export function groupByLetter(persons: readonly Person[], otherLabel: string): PersonGroup[] {
	const buckets = new Map<string, Person[]>();
	for (const person of persons) {
		const letter = groupLetter(person, otherLabel);
		const bucket = buckets.get(letter);
		if (bucket) bucket.push(person);
		else buckets.set(letter, [person]);
	}
	return [...buckets.entries()]
		.map(([letter, list]) => ({ letter, persons: list }))
		.sort((a, b) => {
			if (a.letter === otherLabel) return 1;
			if (b.letter === otherLabel) return -1;
			return a.letter.localeCompare(b.letter);
		});
}

/** Trailing-bucket labels the generic grouper needs, already localized by the
 *  caller — kept off the group objects' `t()` path so a real company / role
 *  name is never routed through a passthrough key. */
export type GroupBucketLabels = {
	/** First-letter "other" bucket (digits / symbols / unnamed). */
	otherLetter: string;
	/** People with no company. */
	noCompany: string;
	/** People with no role. */
	noRole: string;
};

/** Section a person list along the chosen axis, ordering people within each
 *  group by the chosen sort. The trailing catch-all bucket (other letter / no
 *  company / no role) always sorts last; `None` returns one headingless group. */
export function groupPersons(
	persons: readonly Person[],
	grouping: ContactsGrouping,
	sort: ContactsSorting,
	resolvers: PersonViewResolvers,
	labels: GroupBucketLabels,
): PersonGroupView[] {
	const ordered = [...persons].sort((a, b) => comparePersonsBy(a, b, sort, resolvers));

	if (grouping === ContactsGrouping.None) {
		if (ordered.length === 0) return [];
		return [{ key: "all", label: "", trailing: false, persons: ordered }];
	}

	type Bucket = { key: string; label: string; trailing: boolean; persons: Person[] };
	const buckets = new Map<string, Bucket>();
	const add = (key: string, label: string, trailing: boolean, person: Person): void => {
		const bucket = buckets.get(key);
		if (bucket) bucket.persons.push(person);
		else buckets.set(key, { key, label, trailing, persons: [person] });
	};

	for (const person of ordered) {
		if (grouping === ContactsGrouping.FirstLetter) {
			const letter = groupLetter(person, labels.otherLetter);
			add(letter, letter, letter === labels.otherLetter, person);
		} else if (grouping === ContactsGrouping.Company) {
			const name = resolvers.companyName(person.companyId);
			if (name) add(`co:${name.toLocaleLowerCase()}`, name, false, person);
			else add("co:none", labels.noCompany, true, person);
		} else {
			const role = person.role.trim();
			if (role) add(`role:${role.toLocaleLowerCase()}`, role, false, person);
			else add("role:none", labels.noRole, true, person);
		}
	}

	return [...buckets.values()].sort((a, b) => {
		if (a.trailing !== b.trailing) return a.trailing ? 1 : -1;
		return a.label.localeCompare(b.label);
	});
}

/** Filter a person list by a free-text query over name / email / phone / role.
 *  Empty / whitespace query returns the list unchanged. */
export function filterPersons(persons: readonly Person[], query: string): Person[] {
	const q = query.trim().toLocaleLowerCase();
	if (!q) return [...persons];
	return persons.filter((person) => {
		const haystack = [person.name, person.role, ...person.emails, ...person.phones]
			.join(" ")
			.toLocaleLowerCase();
		return haystack.includes(q);
	});
}

/** Build an `id → display name` index over a snapshot once, so per-row /
 *  per-ref name resolution is O(1) instead of an O(N) `find` scan (the list
 *  resolves a company name for every visible row). Unnamed entities are
 *  omitted, so a hit always carries a non-empty name. */
export function buildEntityNameIndex(
	entities: readonly VaultEntityLike[],
): ReadonlyMap<string, string> {
	const index = new Map<string, string>();
	for (const entity of entities) {
		const name = str(entity.properties.name).trim();
		if (name) index.set(entity.id, name);
	}
	return index;
}

/** Resolve an entity id to a display name against a prebuilt index, or `null`
 *  when missing / deleted / unnamed. */
export function resolveName(index: ReadonlyMap<string, string>, id: string | null): string | null {
	return id ? (index.get(id) ?? null) : null;
}
