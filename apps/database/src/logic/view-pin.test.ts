import { describe, expect, it } from "vitest";
import { ViewPinAvailability, canPinToDashboard, viewPinAvailability } from "./view-pin";

describe("view pin (9.12.35)", () => {
	it("needs the dashboard.pin grant (bare or scoped) and the service", () => {
		expect(canPinToDashboard(["dashboard.pin"], true)).toBe(true);
		expect(canPinToDashboard(["dashboard.pin:entity"], true)).toBe(true);
		expect(canPinToDashboard(["dashboard.pinx"], true)).toBe(false);
		expect(canPinToDashboard(["dashboard.pin"], false)).toBe(false);
		expect(canPinToDashboard(undefined, true)).toBe(false);
	});

	it("offers pinning for entity-backed views only", () => {
		const vault = (id: string) => id.startsWith("view_vault_");
		expect(viewPinAvailability("v1", vault, true)).toBe(ViewPinAvailability.Pinnable);
		expect(viewPinAvailability("view_vault_x", vault, true)).toBe(ViewPinAvailability.NotAnObject);
		expect(viewPinAvailability("v1", vault, false)).toBe(ViewPinAvailability.Unsupported);
	});
});
