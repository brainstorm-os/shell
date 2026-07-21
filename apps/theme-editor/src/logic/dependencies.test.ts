import {
	BUILTIN_ICON_PACK,
	BUILTIN_TOKEN_SET,
	BUILTIN_TYPOGRAPHY,
	type ThemeDef,
	ThemeRefKind,
	TokenSetAppearance,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	ThemeSlot,
	builtinFallbackRef,
	missingDependencies,
	themeEntityDependencies,
} from "./dependencies";

function theme(over: Partial<ThemeDef> = {}): ThemeDef {
	return {
		name: "T",
		appearance: TokenSetAppearance.Light,
		tokenSet: { kind: ThemeRefKind.Entity, entityId: "ts-1" },
		iconPack: { kind: ThemeRefKind.Builtin, name: BUILTIN_ICON_PACK },
		typography: { kind: ThemeRefKind.Entity, entityId: "ty-1" },
		...over,
	};
}

describe("themeEntityDependencies", () => {
	it("returns only entity-kind refs, across all four slots", () => {
		const deps = themeEntityDependencies(
			theme({ stylePack: { kind: ThemeRefKind.Entity, entityId: "sp-1" } }),
		);
		expect(deps).toEqual([
			{ slot: ThemeSlot.TokenSet, entityId: "ts-1" },
			{ slot: ThemeSlot.Typography, entityId: "ty-1" },
			{ slot: ThemeSlot.StylePack, entityId: "sp-1" },
		]);
	});

	it("skips builtin refs and an absent stylePack", () => {
		const deps = themeEntityDependencies(
			theme({ tokenSet: { kind: ThemeRefKind.Builtin, name: BUILTIN_TOKEN_SET } }),
		);
		expect(deps).toEqual([{ slot: ThemeSlot.Typography, entityId: "ty-1" }]);
	});
});

describe("missingDependencies", () => {
	it("returns the deps whose entity isn't present", () => {
		const deps = themeEntityDependencies(theme());
		const missing = missingDependencies(deps, new Set(["ts-1"]));
		expect(missing).toEqual([{ slot: ThemeSlot.Typography, entityId: "ty-1" }]);
	});

	it("returns [] when all present", () => {
		const deps = themeEntityDependencies(theme());
		expect(missingDependencies(deps, new Set(["ts-1", "ty-1"]))).toEqual([]);
	});
});

describe("builtinFallbackRef", () => {
	it("maps required slots to their builtin sentinel", () => {
		expect(builtinFallbackRef(ThemeSlot.TokenSet)).toEqual({
			kind: ThemeRefKind.Builtin,
			name: BUILTIN_TOKEN_SET,
		});
		expect(builtinFallbackRef(ThemeSlot.IconPack)).toEqual({
			kind: ThemeRefKind.Builtin,
			name: BUILTIN_ICON_PACK,
		});
		expect(builtinFallbackRef(ThemeSlot.Typography)).toEqual({
			kind: ThemeRefKind.Builtin,
			name: BUILTIN_TYPOGRAPHY,
		});
	});

	it("returns null for the optional StylePack slot (reset removes it)", () => {
		expect(builtinFallbackRef(ThemeSlot.StylePack)).toBeNull();
	});
});
