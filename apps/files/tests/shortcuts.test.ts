/**
 * The Files app's keyboard surface is now the chord *registry* only —
 * matching/binding moved to the shared `@brainstorm-os/sdk/shortcut` layer
 * (B-2), which carries its own `matchesChord`/`attachShortcut` tests in
 * `packages/sdk`. This suite covers what the app still owns: a complete,
 * collision-free `ActionId → chord` registry the renderer feeds into
 * `useShortcut`.
 */

import { describe, expect, it } from "vitest";
import { ActionId, allActionIds, chordFor } from "../src/shortcuts";

describe("Files shortcut registry", () => {
	it("declares a chord for every action id", () => {
		for (const id of allActionIds()) {
			const chord = chordFor(id);
			expect(typeof chord === "string" || chord === null).toBe(true);
		}
	});

	it("exposes every ActionId value through allActionIds()", () => {
		const declared = new Set(allActionIds());
		for (const id of Object.values(ActionId)) {
			expect(declared.has(id)).toBe(true);
		}
		expect(allActionIds().length).toBe(Object.values(ActionId).length);
	});

	it("uses the canonical CmdOrCtrl chord syntax (no platform forks)", () => {
		for (const id of allActionIds()) {
			const chord = chordFor(id);
			if (chord === null) continue;
			// Cross-platform chords use `CmdOrCtrl`, never a hardcoded
			// `Cmd`/`Ctrl` prefix (the SDK layer resolves it per platform).
			expect(/(^|\+)(Cmd|Ctrl)\+/.test(chord)).toBe(false);
		}
	});

	it("maps the documented Files keyboard surface", () => {
		expect(chordFor(ActionId.Search)).toBe("CmdOrCtrl+F");
		expect(chordFor(ActionId.NewFolder)).toBe("CmdOrCtrl+Shift+N");
		expect(chordFor(ActionId.QuickLook)).toBe("Space");
		expect(chordFor(ActionId.Rename)).toBe("Enter");
		expect(chordFor(ActionId.PopoverClose)).toBe("Escape");
	});

	it("has no two action ids bound to the same chord", () => {
		const seen = new Map<string, ActionId>();
		for (const id of allActionIds()) {
			const chord = chordFor(id);
			if (chord === null) continue;
			expect(seen.has(chord)).toBe(false);
			seen.set(chord, id);
		}
	});
});
