/**
 * Graph keyboard chord map invariants. The chords feed
 * `@brainstorm-os/sdk/shortcut` `matchesChord` at runtime (parser is
 * SDK-tested); here we pin the *map* contract: every action is bound, the
 * grammar is the canonical one `matchesChord` understands (`CmdOrCtrl`,
 * never the unsupported `Mod`), and the zoom keys use the unshifted
 * characters a keyboard actually emits (`=`/`-`, not `Plus`/`Minus`,
 * which `normalizeKey` would never produce from a real event). A typo'd
 * chord fails here instead of silently no-op-ing in the app.
 *
 * The test deliberately does not import `@brainstorm-os/sdk/shortcut` — that
 * subpath has no vitest alias and the parser already has its own SDK
 * suite; re-exercising it here would only couple this app test to shell
 * test config we may not edit.
 */

import { describe, expect, it } from "vitest";
import { GRAPH_CHORDS, GraphAction, KEYBOARD_ZOOM_STEP } from "./chords";

describe("GRAPH_CHORDS", () => {
	it("has a non-empty chord for every GraphAction", () => {
		for (const action of Object.values(GraphAction)) {
			expect(GRAPH_CHORDS[action]).toBeTruthy();
		}
		expect(Object.keys(GRAPH_CHORDS).length).toBe(Object.values(GraphAction).length);
	});

	it("never uses the unsupported `Mod` token (must be CmdOrCtrl)", () => {
		for (const chord of Object.values(GRAPH_CHORDS)) {
			expect(chord).not.toMatch(/\bMod\b/);
		}
	});

	it("modified chords resolve via CmdOrCtrl", () => {
		for (const action of [GraphAction.ZoomIn, GraphAction.ZoomOut, GraphAction.ZoomReset]) {
			expect(GRAPH_CHORDS[action].startsWith("CmdOrCtrl+")).toBe(true);
		}
	});

	it("zoom chords end in the unshifted key the keyboard emits", () => {
		expect(GRAPH_CHORDS[GraphAction.ZoomIn]).toBe("CmdOrCtrl+=");
		expect(GRAPH_CHORDS[GraphAction.ZoomOut]).toBe("CmdOrCtrl+-");
		expect(GRAPH_CHORDS[GraphAction.ZoomReset]).toBe("CmdOrCtrl+0");
	});

	it("unmodified chords carry no modifier prefix", () => {
		for (const action of [
			GraphAction.ToggleLocalView,
			GraphAction.ExitLocalView,
			GraphAction.TogglePlayback,
		]) {
			expect(GRAPH_CHORDS[action]).not.toContain("+");
		}
		expect(GRAPH_CHORDS[GraphAction.ExitLocalView]).toBe("Escape");
		expect(GRAPH_CHORDS[GraphAction.TogglePlayback]).toBe("Space");
	});

	it("keeps the keyboard zoom step in lockstep with the on-screen 1.4x", () => {
		expect(KEYBOARD_ZOOM_STEP).toBeCloseTo(1.4);
	});

	it("binds canvas focus navigation to bare Tab / arrows / Enter / Escape", () => {
		expect(GRAPH_CHORDS[GraphAction.FocusNext]).toBe("Tab");
		expect(GRAPH_CHORDS[GraphAction.FocusPrev]).toBe("Shift+Tab");
		expect(GRAPH_CHORDS[GraphAction.FocusUp]).toBe("ArrowUp");
		expect(GRAPH_CHORDS[GraphAction.FocusDown]).toBe("ArrowDown");
		expect(GRAPH_CHORDS[GraphAction.FocusLeft]).toBe("ArrowLeft");
		expect(GRAPH_CHORDS[GraphAction.FocusRight]).toBe("ArrowRight");
		expect(GRAPH_CHORDS[GraphAction.OpenFocused]).toBe("Enter");
		expect(GRAPH_CHORDS[GraphAction.ReleaseFocus]).toBe("Escape");
	});

	it("binds camera pan to CmdOrCtrl+arrows so it never collides with focus arrows", () => {
		expect(GRAPH_CHORDS[GraphAction.PanUp]).toBe("CmdOrCtrl+ArrowUp");
		expect(GRAPH_CHORDS[GraphAction.PanDown]).toBe("CmdOrCtrl+ArrowDown");
		expect(GRAPH_CHORDS[GraphAction.PanLeft]).toBe("CmdOrCtrl+ArrowLeft");
		expect(GRAPH_CHORDS[GraphAction.PanRight]).toBe("CmdOrCtrl+ArrowRight");
	});
});
