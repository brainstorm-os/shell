import { STYLE_PACK_CSS_MIME, type StylePackDef } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import type { EntitiesService, EntityRecord } from "./runtime";
import {
	loadStylePack,
	propertiesToStylePack,
	saveStylePack,
	stylePackToProperties,
} from "./style-pack-repository";

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
				id: id ?? `sp-${++n}`,
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

const pack: StylePackDef = { name: "Polish", css: ".dashboard {}", mime: STYLE_PACK_CSS_MIME };

describe("mappers", () => {
	it("round-trips through properties", () => {
		expect(propertiesToStylePack(stylePackToProperties(pack))).toEqual(pack);
	});

	it("decodes defensively + normalizes mime", () => {
		expect(propertiesToStylePack({ name: 123, css: 456, mime: "x" })).toEqual({
			name: "Untitled style pack",
			css: "",
			mime: STYLE_PACK_CSS_MIME,
		});
		expect(propertiesToStylePack(null).mime).toBe(STYLE_PACK_CSS_MIME);
	});
});

describe("saveStylePack / loadStylePack", () => {
	it("creates then loads", async () => {
		const e = fakeEntities();
		const saved = await saveStylePack(e, pack);
		expect(saved?.type).toBe("brainstorm/StylePack/v1");
		expect(saved?.properties.mime).toBe(STYLE_PACK_CSS_MIME);
		const loaded = await loadStylePack(e, saved?.id ?? "");
		expect(loaded?.def).toEqual(pack);
	});

	it("updates an existing pack by id", async () => {
		const e = fakeEntities();
		const first = await saveStylePack(e, pack);
		const updated = await saveStylePack(e, { ...pack, css: ".x{color:red}" }, first?.id);
		expect(updated?.id).toBe(first?.id);
		expect(e.records).toHaveLength(1);
	});

	it("refuses to save CSS with an error-severity finding", async () => {
		const e = fakeEntities();
		await expect(saveStylePack(e, { ...pack, css: "@import 'evil.css';" })).rejects.toThrow(
			/unsafe CSS/,
		);
	});

	it("returns null outside the shell", async () => {
		expect(await saveStylePack(null, pack)).toBeNull();
		expect(await loadStylePack(undefined, "x")).toBeNull();
	});
});
