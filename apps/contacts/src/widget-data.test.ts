/**
 * Contacts dashboard widget (9.12.13(c)) — pure data-shaping coverage. The
 * `shapeContacts` projection is the widget's only non-presentational logic;
 * the component shell is a faithful mirror of the real-shell-verified Notes
 * recent-notes widget.
 */

import { describe, expect, it } from "vitest";
import { COMPANY_TYPE, PERSON_TYPE } from "./types/person";
import { ContactsSort, type WidgetPersonEntity, shapeContacts } from "./widget-data";

function person(
	id: string,
	properties: Record<string, unknown>,
	updatedAt = 0,
	deletedAt: number | null = null,
): WidgetPersonEntity {
	return { id, type: PERSON_TYPE, properties, updatedAt, deletedAt };
}

function company(
	id: string,
	name: string,
	deletedAt: number | null = null,
): WidgetPersonEntity {
	return { id, type: COMPANY_TYPE, properties: { name }, updatedAt: 0, deletedAt };
}

describe("shapeContacts", () => {
	it("keeps only non-deleted Person/v1 rows", () => {
		const entities: WidgetPersonEntity[] = [
			person("p1", { name: "Ada" }),
			{ ...person("n1", { name: "A note" }), type: "brainstorm/Note/v1" },
			person("p3", { name: "Deleted" }, 0, 123),
		];
		const { contacts, total } = shapeContacts(entities, ContactsSort.Name);
		expect(total).toBe(1);
		expect(contacts.map((c) => c.id)).toEqual(["p1"]);
	});

	it("sorts by name (A→Z, locale-aware) by default", () => {
		const entities = [
			person("c", { name: "Charlie" }),
			person("a", { name: "ada" }),
			person("b", { name: "Bob" }),
		];
		const { contacts } = shapeContacts(entities, ContactsSort.Name);
		expect(contacts.map((c) => c.name)).toEqual(["ada", "Bob", "Charlie"]);
	});

	it("sorts by most-recently-updated under Recent", () => {
		const entities = [
			person("old", { name: "Old" }, 100),
			person("new", { name: "New" }, 300),
			person("mid", { name: "Mid" }, 200),
		];
		const { contacts } = shapeContacts(entities, ContactsSort.Recent);
		expect(contacts.map((c) => c.id)).toEqual(["new", "mid", "old"]);
	});

	it("derives a subtitle from role, then a string company, else empty", () => {
		const entities = [
			person("r", { name: "Role person", role: "Engineer", company: "Acme" }),
			person("c", { name: "Company person", company: "Globex" }),
			person("o", { name: "Object company", company: { id: "co_1" } }),
			person("n", { name: "Nothing" }),
		];
		const byId = new Map(
			shapeContacts(entities, ContactsSort.Name).contacts.map((c) => [c.id, c.subtitle]),
		);
		expect(byId.get("r")).toBe("Engineer");
		expect(byId.get("c")).toBe("Globex");
		expect(byId.get("o")).toBe("");
		expect(byId.get("n")).toBe("");
	});

	it("resolves linked company entity ids to names (F-403)", () => {
		const entities = [
			company("ent_vertex", "Vertex Labs"),
			person("p1", { name: "Jonas", company: "ent_vertex" }),
			// Unresolved ent_ id must not leak onto the tile.
			person("p2", { name: "Unresolved", company: "ent_mrq2jeakonfzl4aj" }),
			// Free-text company names still show as-is.
			person("p3", { name: "Free text", company: "Acme Corp" }),
		];
		const byId = new Map(
			shapeContacts(entities, ContactsSort.Name).contacts.map((c) => [c.id, c.subtitle]),
		);
		expect(byId.get("p1")).toBe("Vertex Labs");
		expect(byId.get("p2")).toBe("");
		expect(byId.get("p3")).toBe("Acme Corp");
	});

	it("falls back to the shared unnamed label when a person has no name", () => {
		const { contacts } = shapeContacts([person("p", { name: "   " })], ContactsSort.Name);
		expect(contacts[0]?.name.length).toBeGreaterThan(0);
	});

	it("caps the projection at the limit but reports the full total", () => {
		const entities = Array.from({ length: 12 }, (_, i) =>
			person(`p${i}`, { name: `Person ${String(i).padStart(2, "0")}` }, i),
		);
		const { contacts, total } = shapeContacts(entities, ContactsSort.Name, 8);
		expect(total).toBe(12);
		expect(contacts).toHaveLength(8);
	});
});
