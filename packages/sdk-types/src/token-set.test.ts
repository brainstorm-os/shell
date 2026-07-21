import { describe, expect, it } from "vitest";
import { CANONICAL_TOKEN_NAMES } from "./token-names";
import {
	EMPTY_TOKEN_SET,
	TOKEN_SET_APPEARANCES,
	TOKEN_SET_TYPE_URL,
	TokenSetAppearance,
	type TokenSetDef,
	TokenSetIssueCode,
	isTokenSetAppearance,
	isValidTokenSet,
	resolveTokenOverrides,
	validateTokenSet,
} from "./token-set";

function tokenSet(over: Partial<TokenSetDef> = {}): TokenSetDef {
	return {
		name: "Test set",
		appearance: TokenSetAppearance.Dark,
		overrides: { "--color-background-primary": "#0a0a0a" },
		...over,
	};
}

describe("constants + frozen tables", () => {
	it("pins the canonical type url", () => {
		expect(TOKEN_SET_TYPE_URL).toBe("brainstorm/TokenSet/v1");
	});

	it("freezes the appearance table and it mirrors the enum", () => {
		expect(Object.isFrozen(TOKEN_SET_APPEARANCES)).toBe(true);
		expect([...TOKEN_SET_APPEARANCES].sort()).toEqual([...Object.values(TokenSetAppearance)].sort());
	});

	it("ships a valid, frozen empty default", () => {
		expect(Object.isFrozen(EMPTY_TOKEN_SET)).toBe(true);
		expect(isValidTokenSet(EMPTY_TOKEN_SET)).toBe(true);
		expect(EMPTY_TOKEN_SET.overrides).toEqual({});
	});

	it("appearance values match the @brainstorm-os/tokens vocabulary", () => {
		expect(TokenSetAppearance.Light).toBe("light");
		expect(TokenSetAppearance.Dark).toBe("dark");
	});
});

describe("isTokenSetAppearance", () => {
	it("accepts members, rejects everything else", () => {
		expect(isTokenSetAppearance("light")).toBe(true);
		expect(isTokenSetAppearance("dark")).toBe(true);
		expect(isTokenSetAppearance("sepia")).toBe(false);
		expect(isTokenSetAppearance(null)).toBe(false);
		expect(isTokenSetAppearance(1)).toBe(false);
	});
});

describe("validateTokenSet", () => {
	it("passes a well-formed set", () => {
		expect(validateTokenSet(tokenSet())).toEqual([]);
	});

	it("flags an empty name", () => {
		const issues = validateTokenSet(tokenSet({ name: "   " }));
		expect(issues.map((i) => i.code)).toContain(TokenSetIssueCode.EmptyName);
	});

	it("flags an invalid appearance", () => {
		const issues = validateTokenSet(tokenSet({ appearance: "neon" as TokenSetAppearance }));
		expect(issues.map((i) => i.code)).toContain(TokenSetIssueCode.InvalidAppearance);
	});

	it("flags a non-object overrides map and stops", () => {
		const issues = validateTokenSet(
			tokenSet({ overrides: null as unknown as Record<string, string> }),
		);
		expect(issues.map((i) => i.code)).toEqual([TokenSetIssueCode.MissingOverrides]);
	});

	it("flags an unknown token name with the offending token", () => {
		const issues = validateTokenSet(tokenSet({ overrides: { "--color-not-real": "#fff" } }));
		const unknown = issues.find((i) => i.code === TokenSetIssueCode.UnknownToken);
		expect(unknown?.token).toBe("--color-not-real");
	});

	it("flags an empty value on a known token", () => {
		const issues = validateTokenSet(tokenSet({ overrides: { "--color-text-primary": "  " } }));
		const empty = issues.find((i) => i.code === TokenSetIssueCode.EmptyValue);
		expect(empty?.token).toBe("--color-text-primary");
	});

	it("accepts every canonical token name as a key", () => {
		const overrides = Object.fromEntries(CANONICAL_TOKEN_NAMES.map((n) => [n, "#abcabc"]));
		expect(validateTokenSet(tokenSet({ overrides }))).toEqual([]);
	});
});

describe("resolveTokenOverrides", () => {
	it("returns only well-formed, known, non-blank pairs", () => {
		const resolved = resolveTokenOverrides(
			tokenSet({
				overrides: {
					"--color-background-primary": "  #111  ",
					"--color-not-real": "#fff",
					"--color-text-primary": "   ",
					"--color-text-secondary": 42 as unknown as string,
				},
			}),
		);
		expect(resolved).toEqual({ "--color-background-primary": "#111" });
	});

	it("never throws on null / partial / malformed input", () => {
		expect(resolveTokenOverrides(null)).toEqual({});
		expect(resolveTokenOverrides(undefined)).toEqual({});
		expect(resolveTokenOverrides({ name: "x" } as unknown as TokenSetDef)).toEqual({});
	});
});
