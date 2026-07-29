// @vitest-environment jsdom
/**
 * Block-chip density bands — each band's content must FIT its minimum chip
 * height (64px/h budget), or the chip's flex column shrinks the meta lines
 * into mid-glyph clipping. Guards the dark-sweep 2026-07-29 find: a ~70min
 * chip showed its time line as clipped ascender tips because guests/tz meta
 * were rendered at every density (the gating predated those lines).
 */

import { describe, expect, it } from "vitest";
import { ChipDensity, densityForDuration } from "./event-chip";

describe("densityForDuration", () => {
	it("maps durations to the four content bands", () => {
		expect(densityForDuration(20)).toBe(ChipDensity.Tight);
		expect(densityForDuration(34)).toBe(ChipDensity.Tight);
		expect(densityForDuration(35)).toBe(ChipDensity.Compact);
		expect(densityForDuration(54)).toBe(ChipDensity.Compact);
		expect(densityForDuration(55)).toBe(ChipDensity.Roomy);
		// A 60-minute event with guests + timezone was the clipping repro —
		// it must NOT get the full-content band (5 lines never fit 64px).
		expect(densityForDuration(60)).toBe(ChipDensity.Roomy);
		expect(densityForDuration(79)).toBe(ChipDensity.Roomy);
		expect(densityForDuration(80)).toBe(ChipDensity.Spacious);
		expect(densityForDuration(120)).toBe(ChipDensity.Spacious);
	});
});
