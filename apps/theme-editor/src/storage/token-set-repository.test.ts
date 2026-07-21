import { EMPTY_TOKEN_SET, TokenSetAppearance, type TokenSetDef } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import type { EntitiesService, EntityRecord } from "./runtime";
import {
	loadTokenSet,
	propertiesToTokenSet,
	saveTokenSet,
	tokenSetToProperties,
} from "./token-set-repository";

function fakeEntities(): EntitiesService & { records: EntityRecord[] } {
	const records: EntityRecord[] = [];
	let n = 0;
	return {
		records,
		async get(id) {
			return records.find((r) => r.id === id) ?? null;
		},
		async query() {
			return records;
		},
		async create(type, properties, id) {
			const rec: EntityRecord = {
				id: id ?? `ts-${++n}`,
				type,
				properties,
				createdAt: 1,
				updatedAt: 1,
			};
			records.push(rec);
			return rec;
		},
		async update(id, patch) {
			const rec = records.find((r) => r.id === id);
			if (!rec) throw new Error("not found");
			rec.properties = { ...rec.properties, ...patch };
			return rec;
		},
		async delete() {},
	};
}

const set: TokenSetDef = {
	name: "Solar dark",
	appearance: TokenSetAppearance.Dark,
	overrides: { "--color-background-primary": "#001" },
};

describe("tokenSetToProperties / propertiesToTokenSet round-trip", () => {
	it("preserves a well-formed set", () => {
		expect(propertiesToTokenSet(tokenSetToProperties(set))).toEqual(set);
	});

	it("drops unknown / blank overrides on decode", () => {
		const out = propertiesToTokenSet({
			name: "X",
			appearance: "dark",
			overrides: { "--color-text-primary": "#fff", "--bogus": "#000", "--color-text-link": "  " },
		});
		expect(out.overrides).toEqual({ "--color-text-primary": "#fff" });
	});

	it("degrades a malformed bag to the empty default", () => {
		const out = propertiesToTokenSet({ name: "  ", appearance: "neon", overrides: null });
		expect(out.name).toBe(EMPTY_TOKEN_SET.name);
		expect(out.appearance).toBe(EMPTY_TOKEN_SET.appearance);
		expect(out.overrides).toEqual({});
	});
});

describe("loadTokenSet / saveTokenSet", () => {
	it("returns null outside the shell", async () => {
		expect(await loadTokenSet(null, "x")).toBeNull();
		expect(await saveTokenSet(null, set)).toBeNull();
	});

	it("creates then loads by id", async () => {
		const e = fakeEntities();
		const saved = await saveTokenSet(e, set);
		expect(saved?.type).toBe("brainstorm/TokenSet/v1");
		const loaded = await loadTokenSet(e, saved?.id ?? "");
		expect(loaded?.def).toEqual(set);
	});

	it("updates an existing set by id", async () => {
		const e = fakeEntities();
		await saveTokenSet(e, set, "ts-fixed");
		await saveTokenSet(e, { ...set, name: "Renamed" }, "ts-fixed");
		expect(e.records).toHaveLength(1);
		expect(e.records[0]?.properties.name).toBe("Renamed");
	});

	it("refuses to persist an invalid set", async () => {
		const e = fakeEntities();
		const bad = { ...set, overrides: { "--bogus": "#000" } } as TokenSetDef;
		await expect(saveTokenSet(e, bad)).rejects.toThrow();
		expect(e.records).toHaveLength(0);
	});
});
