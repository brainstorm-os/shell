/**
 * `readEntityIcon` enforces the per-object-icons-everywhere invariant in
 * the Database inspector: it returns the object's OWN validated `Icon`
 * (so the inspector + grid render it), or `null` so the caller falls
 * back to the *type* glyph — never the type glyph as the object's icon.
 *
 * It lives in `src/logic/entity-icon.ts` — a renderer-free module — so
 * this test imports it WITHOUT booting the Database app. (Booting `app.ts`
 * at module-eval schedules async work that outlived the jsdom env and
 * surfaced as intermittent `window is not defined` unhandled errors in
 * the CI full-suite run.)
 */

import { IconKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { readEntityIcon } from "../src/logic/entity-icon";

function row(properties: Record<string, unknown>) {
	return {
		id: "e1",
		type: "io.brainstorm.Note/v1",
		properties,
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
	};
}

describe("readEntityIcon (per-object-icons-everywhere)", () => {
	it("returns the object's own emoji / pack / image icon verbatim", () => {
		expect(readEntityIcon(row({ icon: { kind: IconKind.Emoji, value: "🌟" } }))).toEqual({
			kind: IconKind.Emoji,
			value: "🌟",
		});
		expect(readEntityIcon(row({ icon: { kind: IconKind.Pack, value: "phosphor/star" } }))?.kind).toBe(
			IconKind.Pack,
		);
		expect(
			readEntityIcon(row({ icon: { kind: IconKind.Image, value: "brainstorm://icon/a.png" } }))?.value,
		).toBe("brainstorm://icon/a.png");
	});

	it("returns null (→ type-glyph fallback) when there is no valid own icon", () => {
		expect(readEntityIcon(row({}))).toBeNull();
		expect(readEntityIcon(row({ icon: null }))).toBeNull();
		expect(readEntityIcon(row({ icon: "🌟" }))).toBeNull();
		expect(readEntityIcon(row({ icon: { kind: IconKind.Emoji, value: "" } }))).toBeNull();
		expect(readEntityIcon(row({ icon: { kind: "bogus", value: "x" } }))).toBeNull();
	});
});
