import type { VaultEntity } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { TypeaheadOptionKind, buildTypeaheadOptions } from "./typeahead-options";

// 2026-06-04 (a Thursday) at local noon — deterministic "now" for the date math.
const NOW = new Date(2026, 5, 4, 12, 0, 0).getTime();

function entity(id: string, title: string): VaultEntity {
	return {
		id,
		type: "io.brainstorm.notes/Note/v1",
		properties: { title },
	} as unknown as VaultEntity;
}

const ENTITIES = [entity("n1", "Today's standup"), entity("n2", "Roadmap")];

describe("buildTypeaheadOptions", () => {
	it("lists date candidates before entity matches", () => {
		const opts = buildTypeaheadOptions(ENTITIES, "to", NOW);
		expect(opts[0]?.kind).toBe(TypeaheadOptionKind.Date);
		// "to" prefix-matches the "today"/"tomorrow" keywords (dates) and the
		// "Today's standup" note (entity); every date comes before every entity.
		const firstEnt = opts.findIndex((o) => o.kind === TypeaheadOptionKind.Entity);
		const lastDate = opts.reduce((acc, o, i) => (o.kind === TypeaheadOptionKind.Date ? i : acc), -1);
		expect(firstEnt).toBeGreaterThanOrEqual(0);
		expect(lastDate).toBeLessThan(firstEnt);
	});

	it("resolves the relative keyword to the right ISO day", () => {
		const opts = buildTypeaheadOptions([], "today", NOW);
		expect(opts).toHaveLength(1);
		const first = opts[0];
		expect(first?.kind).toBe(TypeaheadOptionKind.Date);
		if (first?.kind === TypeaheadOptionKind.Date) {
			expect(first.date.iso).toBe("2026-06-04");
			expect(first.date.label).toBe("Today");
		}
	});

	it("offers a typed ISO day as a date option", () => {
		const opts = buildTypeaheadOptions([], "2026-01-15", NOW);
		expect(opts).toHaveLength(1);
		const first = opts[0];
		if (first?.kind === TypeaheadOptionKind.Date) {
			expect(first.date.iso).toBe("2026-01-15");
			expect(first.date.label).toBe("2026-01-15");
		}
	});

	it("shows all relative keywords on an empty query, then every entity", () => {
		const opts = buildTypeaheadOptions(ENTITIES, "", NOW);
		const dates = opts.filter((o) => o.kind === TypeaheadOptionKind.Date);
		const ents = opts.filter((o) => o.kind === TypeaheadOptionKind.Entity);
		expect(dates).toHaveLength(3); // today / tomorrow / yesterday
		expect(ents).toHaveLength(2);
	});

	it("excludes the open note from entity matches", () => {
		const opts = buildTypeaheadOptions(ENTITIES, "", NOW, new Set(["n1"]));
		const ents = opts.filter((o) => o.kind === TypeaheadOptionKind.Entity);
		expect(ents).toHaveLength(1);
		if (ents[0]?.kind === TypeaheadOptionKind.Entity) expect(ents[0].entity.id).toBe("n2");
	});

	it("returns only entity matches when the query isn't a date", () => {
		const opts = buildTypeaheadOptions(ENTITIES, "roadmap", NOW);
		expect(opts.every((o) => o.kind === TypeaheadOptionKind.Entity)).toBe(true);
		expect(opts).toHaveLength(1);
	});
});
