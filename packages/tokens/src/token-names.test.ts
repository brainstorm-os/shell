import { CANONICAL_TOKEN_NAMES } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { defaultLight, flattenTokens } from "./index";

/**
 * Drift guard — the `CANONICAL_TOKEN_NAMES` snapshot in
 * `@brainstorm-os/sdk-types` is the namespace a `brainstorm/TokenSet/v1`
 * validates against (doc 40 §Validation). It is a hand-maintained copy
 * (sdk-types stays dependency-free of the tokens runtime), so this test
 * pins it to the live `flattenTokens` key space. When a token is
 * added/removed/renamed in `tokens.ts`, this fails until the snapshot is
 * re-synced.
 */
describe("CANONICAL_TOKEN_NAMES snapshot", () => {
	it("matches the flattened @brainstorm-os/tokens key space", () => {
		const live = Object.keys(flattenTokens(defaultLight)).sort();
		expect([...CANONICAL_TOKEN_NAMES]).toEqual(live);
	});
});
