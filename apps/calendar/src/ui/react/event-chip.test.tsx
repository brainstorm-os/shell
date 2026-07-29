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
		expect(densityForDuration(43)).toBe(ChipDensity.Tight);
		expect(densityForDuration(44)).toBe(ChipDensity.Compact);
		// The 60-minute repro chip (64px) fits exactly title (26px) + time
		// (46px); location (66px) and guests/tz (106px) must stay gated.
		expect(densityForDuration(60)).toBe(ChipDensity.Compact);
		expect(densityForDuration(71)).toBe(ChipDensity.Compact);
		expect(densityForDuration(72)).toBe(ChipDensity.Roomy);
		expect(densityForDuration(99)).toBe(ChipDensity.Roomy);
		expect(densityForDuration(100)).toBe(ChipDensity.Spacious);
		expect(densityForDuration(150)).toBe(ChipDensity.Spacious);
	});
});
