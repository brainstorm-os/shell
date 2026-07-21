import { describe, expect, it } from "vitest";
import { CODE_EDITOR_CHORDS, CodeEditorAction } from "./shortcuts";

/**
 * The chord *grammar* (`Mod+…+Key`, mods drawn from
 * Cmd/Ctrl/CmdOrCtrl/Alt/Shift) is the shell registry's stable contract —
 * `@brainstorm-os/sdk/shortcut`'s `matchesChord` parses exactly this. We
 * assert the declared chords against that grammar rather than importing
 * the SDK matcher: the `@brainstorm-os/sdk/shortcut` subpath has no vitest
 * alias yet (a shared-config gap reported to the integrator), and the
 * production runtime resolves it fine via the package `exports` map.
 */

const MODS = new Set(["Cmd", "Ctrl", "CmdOrCtrl", "Alt", "Shift"]);

function parseChord(chord: string): { mods: string[]; key: string } {
	const parts = chord.split("+").map((p) => p.trim());
	const key = parts[parts.length - 1] ?? "";
	return { mods: parts.slice(0, -1), key };
}

describe("code-editor shortcuts", () => {
	it("declares a chord for every action", () => {
		for (const action of Object.values(CodeEditorAction)) {
			expect(CODE_EDITOR_CHORDS[action], `${action} must have a chord`).toBeTruthy();
		}
	});

	it("declares unique chords apart from the deliberate file-nav / line-move overlap", () => {
		// Alt+Arrow is shared on purpose: file nav binds on the window, the
		// line-move ops bind on the focused textarea and stop propagation, so
		// focus disambiguates which one fires (see code-pane.ts). Those are the
		// only two allowed collisions; every other chord must be unique.
		const scopedOverlap = new Set([CodeEditorAction.MoveLineUp, CodeEditorAction.MoveLineDown]);
		const chords = Object.entries(CODE_EDITOR_CHORDS)
			.filter(([action]) => !scopedOverlap.has(action as CodeEditorAction))
			.map(([, chord]) => chord);
		expect(new Set(chords).size).toBe(chords.length);
	});

	it("shares Alt+Arrow between window file-nav and buffer line-move by design", () => {
		expect(CODE_EDITOR_CHORDS[CodeEditorAction.MoveLineUp]).toBe(
			CODE_EDITOR_CHORDS[CodeEditorAction.FilePrev],
		);
		expect(CODE_EDITOR_CHORDS[CodeEditorAction.MoveLineDown]).toBe(
			CODE_EDITOR_CHORDS[CodeEditorAction.FileNext],
		);
	});

	it("every chord is well-formed: known mods + a non-empty key", () => {
		for (const chord of Object.values(CODE_EDITOR_CHORDS)) {
			const { mods, key } = parseChord(chord);
			expect(key.length, `${chord} must end in a key`).toBeGreaterThan(0);
			for (const m of mods) {
				expect(MODS.has(m), `${chord} uses an unknown modifier "${m}"`).toBe(true);
			}
		}
	});

	it("binds the expected chords for the four declared actions", () => {
		expect(CODE_EDITOR_CHORDS[CodeEditorAction.Save]).toBe("CmdOrCtrl+S");
		expect(CODE_EDITOR_CHORDS[CodeEditorAction.FilePrev]).toBe("Alt+ArrowUp");
		expect(CODE_EDITOR_CHORDS[CodeEditorAction.FileNext]).toBe("Alt+ArrowDown");
		expect(CODE_EDITOR_CHORDS[CodeEditorAction.FocusReferences]).toBe("CmdOrCtrl+Shift+R");
	});
});
