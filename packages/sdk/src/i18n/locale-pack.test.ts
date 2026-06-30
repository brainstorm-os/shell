import { describe, expect, it, vi } from "vitest";
import {
	type LocalePackImporters,
	SOURCE_LANGUAGE,
	localeFallbackChain,
	resolveLocalePack,
} from "./common-labels";

type Manifest = { greeting: string; bye: string };

describe("localeFallbackChain (12.15 15c)", () => {
	it("walks region → base → source", () => {
		expect(localeFallbackChain("de-AT")).toEqual(["de-AT", "de", "en"]);
	});

	it("dedupes and always ends at the source language", () => {
		expect(localeFallbackChain("es")).toEqual(["es", "en"]);
		expect(localeFallbackChain("en")).toEqual(["en"]);
	});

	it("exposes the shared source-language constant", () => {
		expect(SOURCE_LANGUAGE).toBe("en");
	});
});

describe("resolveLocalePack (12.15 15c)", () => {
	const pack = (partial: Partial<Manifest>): LocalePackImporters<Manifest>[string] =>
		vi.fn(async () => ({ default: partial }));

	it("returns the overlay for an exact-tag match", async () => {
		const importers: LocalePackImporters<Manifest> = { es: pack({ greeting: "Hola" }) };
		expect(await resolveLocalePack("es", importers)).toEqual({ greeting: "Hola" });
	});

	it("falls back from a region tag to its base pack", async () => {
		const base = pack({ greeting: "Hallo" });
		const importers: LocalePackImporters<Manifest> = { de: base };
		expect(await resolveLocalePack("de-AT", importers)).toEqual({ greeting: "Hallo" });
		expect(base).toHaveBeenCalledOnce();
	});

	it("short-circuits to null for the source language (English = inline manifest)", async () => {
		const en = pack({ greeting: "Hi" });
		const importers: LocalePackImporters<Manifest> = { en };
		expect(await resolveLocalePack("en", importers)).toBeNull();
		expect(en).not.toHaveBeenCalled();
	});

	it("returns null when no chain entry has a pack", async () => {
		expect(await resolveLocalePack("fr", {})).toBeNull();
	});

	it("tolerates an import failure and keeps walking the chain", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const importers: LocalePackImporters<Manifest> = {
			"de-AT": vi.fn(async () => {
				throw new Error("network");
			}),
			de: pack({ bye: "Tschüss" }),
		};
		expect(await resolveLocalePack("de-AT", importers)).toEqual({ bye: "Tschüss" });
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("returns null when the only matching pack fails to import", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const importers: LocalePackImporters<Manifest> = {
			es: vi.fn(async () => {
				throw new Error("boom");
			}),
		};
		expect(await resolveLocalePack("es", importers)).toBeNull();
		warn.mockRestore();
	});
});
