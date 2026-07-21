/**
 * Declared keyboard chords for the Journal app. Chord strings use the
 * shared `@brainstorm-os/sdk/shortcut` syntax (`[<Mod>+]<Key>`); they are
 * bound in `app.ts` via `attachShortcut`. Centralised here (not inline
 * `e.key`) so the keyboard contract is greppable and the parser is the
 * shared one — per the no-raw-`e.key` convention.
 *
 * This module is intentionally dependency-free (no SDK import) so it is
 * unit-testable without the shortcut subpath alias.
 */

export enum JournalChordId {
	PrevPeriod = "journal.prev-period",
	NextPeriod = "journal.next-period",
	GoToToday = "journal.go-to-today",
	GoToDate = "journal.go-to-date",
	Search = "journal.search",
	ModeDay = "journal.mode-day",
	ModeWeek = "journal.mode-week",
	ModeMonth = "journal.mode-month",
	OpenFocusedDay = "journal.open-focused-day",
}

/** The bound chord string per action. ⌘/Ctrl-prefixed where the bare key
 *  would collide with a text field; bare arrows/letters are safe because
 *  the Journal body has no editable surface (editing happens in Notes). */
export const JOURNAL_CHORDS: Readonly<Record<JournalChordId, string>> = Object.freeze({
	[JournalChordId.PrevPeriod]: "ArrowLeft",
	[JournalChordId.NextPeriod]: "ArrowRight",
	[JournalChordId.GoToToday]: "T",
	[JournalChordId.GoToDate]: "CmdOrCtrl+G",
	[JournalChordId.Search]: "CmdOrCtrl+Shift+F",
	[JournalChordId.ModeDay]: "D",
	[JournalChordId.ModeWeek]: "W",
	[JournalChordId.ModeMonth]: "M",
	[JournalChordId.OpenFocusedDay]: "CmdOrCtrl+Enter",
});
