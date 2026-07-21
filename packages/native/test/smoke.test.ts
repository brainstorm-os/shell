import { describe, expect, it } from "vitest";

describe("@brainstorm-os/native — NAPI-1 foundation", () => {
	it("loads the compiled .node binary and round-trips an int through Rust", async () => {
		const mod = (await import("../index.js")) as { smokeSum: (a: number, b: number) => number };
		expect(mod.smokeSum(40, 2)).toBe(42);
		expect(mod.smokeSum(-1, 1)).toBe(0);
		expect(mod.smokeSum(2_147_483_640, 7)).toBe(2_147_483_647);
	});
});
