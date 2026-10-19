import { describe, expect, it } from "vitest";
import { auditAppI18n } from "./check-app-i18n.mjs";

const base = {
	appId: "io.example.app",
	decl: { source: "en", locales: ["en", "es"] },
	sourceKeys: ["greeting", "bye"],
	packs: { es: { ok: true, keys: ["greeting"] } },
	discoveredLocales: ["es"],
};

describe("auditAppI18n (12.15 15c)", () => {
	it("passes a well-formed declaration", () => {
		expect(auditAppI18n(base)).toEqual([]);
	});

	it("flags a declared locale with no pack file on disk", () => {
		const errors = auditAppI18n({ ...base, packs: { es: undefined }, discoveredLocales: [] });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/no src\/i18n\/es\.json/);
	});

	it("flags an invalid-JSON pack", () => {
		const errors = auditAppI18n({
			...base,
			packs: { es: { ok: false, error: "Unexpected token" } },
		});
		expect(errors[0]).toMatch(/not valid JSON/);
	});

	it("flags pack keys that are absent from the source catalog", () => {
		const errors = auditAppI18n({
			...base,
			packs: { es: { ok: true, keys: ["greeting", "typo.key"] } },
		});
		expect(errors[0]).toMatch(/typo\.key/);
	});

	it("flags a pack missing source keys when the catalog is extracted", () => {
		const errors = auditAppI18n({ ...base, requireComplete: true });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/missing source keys: bye/);
	});

	it("tolerates a partial pack when the source is an inline manifest", () => {
		expect(auditAppI18n({ ...base, requireComplete: false })).toEqual([]);
	});

	it("skips the subset check when the source catalog can't be resolved", () => {
		const errors = auditAppI18n({
			...base,
			sourceKeys: null,
			packs: { es: { ok: true, keys: ["whatever"] } },
		});
		expect(errors).toEqual([]);
	});

	it("flags an orphan pack file that isn't declared", () => {
		const errors = auditAppI18n({
			appId: "io.example.app",
			decl: { source: "en", locales: ["en"] },
			sourceKeys: ["greeting"],
			packs: {},
			discoveredLocales: ["de"],
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/de\.json exists but is not declared/);
	});

	it("flags a source language missing from its own locales list", () => {
		const errors = auditAppI18n({
			appId: "io.example.app",
			decl: { source: "en", locales: ["es"] },
			sourceKeys: ["greeting"],
			packs: { es: { ok: true, keys: ["greeting"] } },
			discoveredLocales: ["es"],
		});
		expect(errors.some((e) => /source "en" is not listed/.test(e))).toBe(true);
	});

	it("requires no pack for a source-only declaration (English fallback)", () => {
		const errors = auditAppI18n({
			appId: "io.example.app",
			decl: { source: "en", locales: ["en"] },
			sourceKeys: ["greeting"],
			packs: {},
			discoveredLocales: [],
		});
		expect(errors).toEqual([]);
	});
});
