import { describe, expect, it } from "vitest";
import { isPublicBeta } from "./beta";

describe("isPublicBeta", () => {
	it("treats 0.x as public beta", () => {
		expect(isPublicBeta("0.4.2")).toBe(true);
		expect(isPublicBeta("0.1.0-beta.1")).toBe(true);
	});

	it("treats 1.0+ as GA (analytics off)", () => {
		expect(isPublicBeta("1.0.0")).toBe(false);
		expect(isPublicBeta("2.3.1")).toBe(false);
	});
});