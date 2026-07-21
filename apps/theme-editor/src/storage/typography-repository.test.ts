import { SYSTEM_TYPOGRAPHY, type TypographyDef, TypographyScale } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import type { EntitiesService, EntityRecord } from "./runtime";
import {
	loadTypography,
	propertiesToTypography,
	saveTypography,
	typographyToProperties,
} from "./typography-repository";

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
				id: id ?? `ty-${++n}`,
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

const typo: TypographyDef = {
	name: "Serif reading",
	scale: TypographyScale.Comfortable,
	fonts: {
		ui: { stack: "Inter, sans-serif" },
		body: { stack: "Georgia, serif" },
		code: { stack: "JetBrains Mono, monospace" },
		display: { stack: "Playfair Display, serif" },
	},
};

describe("typographyToProperties / propertiesToTypography round-trip", () => {
	it("preserves a well-formed typography", () => {
		expect(propertiesToTypography(typographyToProperties(typo))).toEqual(typo);
	});

	it("fills blank/missing roles from the system stacks", () => {
		const out = propertiesToTypography({
			name: "Partial",
			scale: "default",
			fonts: { ui: { stack: "  " }, body: { stack: "Lora, serif" } },
		});
		expect(out.fonts.ui.stack).toBe(SYSTEM_TYPOGRAPHY.fonts.ui.stack);
		expect(out.fonts.body.stack).toBe("Lora, serif");
		expect(out.fonts.code.stack).toBe(SYSTEM_TYPOGRAPHY.fonts.code.stack);
	});

	it("degrades a malformed bag (blank name, bad scale, no fonts)", () => {
		const out = propertiesToTypography({ name: "  ", scale: "huge", fonts: null });
		expect(out.name).toBe(SYSTEM_TYPOGRAPHY.name);
		expect(out.scale).toBe(SYSTEM_TYPOGRAPHY.scale);
		expect(out.fonts.display.stack).toBe(SYSTEM_TYPOGRAPHY.fonts.display.stack);
	});
});

describe("loadTypography / saveTypography", () => {
	it("returns null outside the shell", async () => {
		expect(await loadTypography(null, "x")).toBeNull();
		expect(await saveTypography(null, typo)).toBeNull();
	});

	it("creates then loads by id", async () => {
		const e = fakeEntities();
		const saved = await saveTypography(e, typo);
		expect(saved?.type).toBe("brainstorm/Typography/v1");
		expect((await loadTypography(e, saved?.id ?? ""))?.def).toEqual(typo);
	});

	it("updates an existing typography by id", async () => {
		const e = fakeEntities();
		await saveTypography(e, typo, "ty-1");
		await saveTypography(e, { ...typo, name: "Renamed" }, "ty-1");
		expect(e.records).toHaveLength(1);
		expect(e.records[0]?.properties.name).toBe("Renamed");
	});

	it("refuses to persist an invalid typography", async () => {
		const e = fakeEntities();
		const bad = { ...typo, fonts: { ...typo.fonts, code: { stack: "" } } } as TypographyDef;
		await expect(saveTypography(e, bad)).rejects.toThrow();
		expect(e.records).toHaveLength(0);
	});
});
