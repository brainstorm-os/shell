import {
	DEFAULT_THEME_COMPOSITE,
	type ThemeDef,
	ThemeRefKind,
	TokenSetAppearance,
	type VaultEntity,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import type { EntitiesService, EntityRecord } from "./runtime";
import {
	loadTheme,
	propertiesToTheme,
	saveTheme,
	themeToProperties,
	themesFromSnapshot,
} from "./theme-repository";

function vaultEntity(over: Partial<VaultEntity>): VaultEntity {
	return {
		id: "e",
		type: "brainstorm/Theme/v1",
		properties: {},
		createdAt: 1,
		updatedAt: 1,
		deletedAt: null,
		ownerAppId: "io.brainstorm.theme-editor",
		...over,
	};
}

describe("themesFromSnapshot", () => {
	it("projects Theme/v1 entities to {id, name}, skipping other types + deleted", () => {
		const out = themesFromSnapshot([
			vaultEntity({ id: "t1", properties: { name: "Midnight Pro" } }),
			vaultEntity({ id: "n1", type: "brainstorm/Note/v1", properties: { name: "Note" } }),
			vaultEntity({ id: "t2", properties: { name: "Gone" }, deletedAt: 99 }),
			vaultEntity({ id: "t3", properties: {} }),
		]);
		expect(out).toEqual([
			{ id: "t1", name: "Midnight Pro" },
			{ id: "t3", name: "t3" },
		]);
	});
});

function fakeEntities(seed: EntityRecord[] = []): EntitiesService & { records: EntityRecord[] } {
	const records = [...seed];
	let n = seed.length;
	return {
		records,
		async get(id) {
			return records.find((r) => r.id === id) ?? null;
		},
		async query(q) {
			const types = q.type === undefined ? null : Array.isArray(q.type) ? q.type : [q.type];
			return types ? records.filter((r) => types.includes(r.type)) : records;
		},
		async create(type, properties, id) {
			const rec: EntityRecord = {
				id: id ?? `theme-${++n}`,
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
			rec.updatedAt = 2;
			return rec;
		},
		async delete(id) {
			const i = records.findIndex((r) => r.id === id);
			if (i >= 0) records.splice(i, 1);
		},
	};
}

const theme: ThemeDef = {
	name: "Solarized",
	appearance: TokenSetAppearance.Dark,
	tokenSet: { kind: ThemeRefKind.Entity, entityId: "ts-1" },
	iconPack: { kind: ThemeRefKind.Builtin, name: "phosphor" },
	typography: { kind: ThemeRefKind.Builtin, name: "system" },
};

describe("themeToProperties / propertiesToTheme round-trip", () => {
	it("preserves a well-formed theme", () => {
		expect(propertiesToTheme(themeToProperties(theme))).toEqual(theme);
	});

	it("omits stylePack when absent and carries it when present", () => {
		expect(themeToProperties(theme).stylePack).toBeUndefined();
		const withStyle: ThemeDef = {
			...theme,
			stylePack: { kind: ThemeRefKind.Entity, entityId: "sp-1" },
		};
		expect(propertiesToTheme(themeToProperties(withStyle))).toEqual(withStyle);
	});

	it("degrades a malformed bag to per-field defaults; never half-broken", () => {
		const out = propertiesToTheme({ name: "  ", appearance: "neon", tokenSet: { kind: "bad" } });
		expect(out.name).toBe(DEFAULT_THEME_COMPOSITE.name);
		expect(out.appearance).toBe(DEFAULT_THEME_COMPOSITE.appearance);
		expect(out.tokenSet).toEqual({ kind: ThemeRefKind.Builtin, name: "shell/default-light" });
	});

	it("tolerates null/empty properties", () => {
		expect(propertiesToTheme(null).name).toBe(DEFAULT_THEME_COMPOSITE.name);
		expect(propertiesToTheme(undefined).iconPack).toEqual({
			kind: ThemeRefKind.Builtin,
			name: "phosphor",
		});
	});
});

describe("loadTheme", () => {
	it("returns null outside the shell (no entities service)", async () => {
		expect(await loadTheme(null)).toBeNull();
	});

	it("returns the first stored theme when no id is given", async () => {
		const e = fakeEntities();
		await e.create("brainstorm/Theme/v1", themeToProperties(theme), "t-1");
		const loaded = await loadTheme(e);
		expect(loaded?.id).toBe("t-1");
		expect(loaded?.def).toEqual(theme);
	});

	it("returns null when the vault has no theme", async () => {
		expect(await loadTheme(fakeEntities())).toBeNull();
	});

	it("loads a specific theme by id", async () => {
		const e = fakeEntities();
		await e.create("brainstorm/Theme/v1", themeToProperties(theme), "t-9");
		const loaded = await loadTheme(e, "t-9");
		expect(loaded?.id).toBe("t-9");
	});
});

describe("saveTheme", () => {
	it("returns null outside the shell", async () => {
		expect(await saveTheme(null, theme)).toBeNull();
	});

	it("creates when there is no id", async () => {
		const e = fakeEntities();
		const rec = await saveTheme(e, theme);
		expect(rec?.type).toBe("brainstorm/Theme/v1");
		expect(e.records).toHaveLength(1);
	});

	it("updates an existing theme by id", async () => {
		const e = fakeEntities();
		await e.create("brainstorm/Theme/v1", themeToProperties(theme), "t-1");
		const rec = await saveTheme(e, { ...theme, name: "Renamed" }, "t-1");
		expect(rec?.properties.name).toBe("Renamed");
		expect(e.records).toHaveLength(1);
	});

	it("creates with the given id when that id is not yet present", async () => {
		const e = fakeEntities();
		const rec = await saveTheme(e, theme, "fresh-id");
		expect(rec?.id).toBe("fresh-id");
	});

	it("refuses to persist a structurally invalid theme", async () => {
		const e = fakeEntities();
		const bad = {
			...theme,
			name: "  ",
			tokenSet: { kind: ThemeRefKind.Entity, entityId: "" },
		} as ThemeDef;
		await expect(saveTheme(e, bad)).rejects.toThrow();
		expect(e.records).toHaveLength(0);
	});
});
