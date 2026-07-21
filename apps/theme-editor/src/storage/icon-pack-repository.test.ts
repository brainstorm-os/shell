import { type IconPackDef, IconPackStyle, type VaultEntity } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	iconPacksFromSnapshot,
	listIconPacks,
	loadIconPack,
	propertiesToIconPack,
} from "./icon-pack-repository";
import type { EntitiesService, EntityRecord } from "./runtime";

function vaultEntity(over: Partial<VaultEntity>): VaultEntity {
	return {
		id: "e",
		type: "brainstorm/IconPack/v1",
		properties: {},
		createdAt: 1,
		updatedAt: 1,
		deletedAt: null,
		ownerAppId: "io.brainstorm.theme-editor",
		...over,
	};
}

describe("iconPacksFromSnapshot", () => {
	it("projects IconPack/v1 entities to {id, name}, skipping other types + deleted", () => {
		const out = iconPacksFromSnapshot([
			vaultEntity({ id: "p1", properties: { name: "Hand-drawn" } }),
			vaultEntity({ id: "x", type: "brainstorm/Theme/v1", properties: { name: "Theme" } }),
			vaultEntity({ id: "p2", properties: { name: "Gone" }, deletedAt: 5 }),
			vaultEntity({ id: "p3", properties: {} }),
		]);
		expect(out).toEqual([
			{ id: "p1", name: "Hand-drawn" },
			{ id: "p3", name: "p3" },
		]);
	});
});

const validPack: IconPackDef = {
	name: "Hand-drawn",
	version: "1.0.0",
	license: "MIT",
	metadata: { style: IconPackStyle.HandDrawn },
	icons: { save: { svg: "<path/>" } },
	fallback: "save",
};

function fakeEntities(seed: EntityRecord[] = []): EntitiesService {
	const records = [...seed];
	return {
		async get(id) {
			return records.find((r) => r.id === id) ?? null;
		},
		async query() {
			return records;
		},
		async create() {
			throw new Error("unused");
		},
		async update() {
			throw new Error("unused");
		},
		async delete() {},
	};
}

function packRecord(id: string, props: Record<string, unknown>): EntityRecord {
	return { id, type: "brainstorm/IconPack/v1", properties: props, createdAt: 1, updatedAt: 1 };
}

describe("propertiesToIconPack", () => {
	it("rebuilds a valid pack", () => {
		expect(propertiesToIconPack(validPack as unknown as Record<string, unknown>)).toEqual(validPack);
	});

	it("returns null for an invalid/partial pack (never previews a broken pack)", () => {
		expect(propertiesToIconPack({ name: "X" })).toBeNull();
		expect(propertiesToIconPack(null)).toBeNull();
		expect(
			propertiesToIconPack({ ...validPack, fallback: "missing" } as Record<string, unknown>),
		).toBeNull();
	});
});

describe("listIconPacks", () => {
	it("returns [] outside the shell", async () => {
		expect(await listIconPacks(null)).toEqual([]);
	});

	it("lists installed packs by id + name (name falls back to id)", async () => {
		const e = fakeEntities([
			packRecord("p1", { name: "Hand-drawn" }),
			packRecord("p2", { name: "  " }),
		]);
		expect(await listIconPacks(e)).toEqual([
			{ id: "p1", name: "Hand-drawn" },
			{ id: "p2", name: "p2" },
		]);
	});
});

describe("loadIconPack", () => {
	it("loads + validates a pack by id; null for a broken one", async () => {
		const e = fakeEntities([
			packRecord("p1", validPack as unknown as Record<string, unknown>),
			packRecord("p2", { name: "broken" }),
		]);
		expect(await loadIconPack(e, "p1")).toEqual(validPack);
		expect(await loadIconPack(e, "p2")).toBeNull();
		expect(await loadIconPack(e, "missing")).toBeNull();
	});

	it("returns null outside the shell", async () => {
		expect(await loadIconPack(null, "p1")).toBeNull();
	});
});
