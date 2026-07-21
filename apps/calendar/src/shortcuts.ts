/**
 * App-side keyboard delivery per
 * §Keyboard handling. Every keyboard interaction routes through an
 * action id; no raw `e.key` outside this module. Chord *matching* is the
 * shared `@brainstorm-os/sdk/shortcut` parser (the per-app chord parser
 * stopgap is retired per the shared-fundamentals contract) — this module
 * keeps only the action-id registry + the typing-target guard the shared
 * binder intentionally doesn't impose.
 */

import { matchesChord } from "@brainstorm-os/sdk/shortcut";

export const ActionId = {
	GoMonth: "brainstorm.calendar/go-month",
	GoWeek: "brainstorm.calendar/go-week",
	GoDay: "brainstorm.calendar/go-day",
	GoAgenda: "brainstorm.calendar/go-agenda",
	GoYear: "brainstorm.calendar/go-year",
	GoToday: "brainstorm.calendar/go-today",
	GoPrevRange: "brainstorm.calendar/go-prev-range",
	GoNextRange: "brainstorm.calendar/go-next-range",
	Compose: "brainstorm.calendar/compose",
	Search: "brainstorm.calendar/search",
} as const;

export type ActionId = (typeof ActionId)[keyof typeof ActionId];

const DEFAULT_CHORDS: Record<ActionId, readonly string[]> = {
	[ActionId.GoMonth]: ["CmdOrCtrl+1"],
	[ActionId.GoWeek]: ["CmdOrCtrl+2"],
	[ActionId.GoDay]: ["CmdOrCtrl+3"],
	[ActionId.GoAgenda]: ["CmdOrCtrl+4"],
	[ActionId.GoYear]: ["CmdOrCtrl+5"],
	[ActionId.GoToday]: ["T"],
	[ActionId.GoPrevRange]: ["ArrowLeft"],
	[ActionId.GoNextRange]: ["ArrowRight"],
	[ActionId.Compose]: ["CmdOrCtrl+n"],
	[ActionId.Search]: ["CmdOrCtrl+f"],
};

type Handler = (event: KeyboardEvent) => void;

export function bindShortcut(id: ActionId, handler: Handler): () => void {
	const chords = DEFAULT_CHORDS[id];
	if (!chords || chords.length === 0) return noop;

	function onKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented) return;
		if (isTypingTarget(event.target)) return;
		for (const chord of chords) {
			if (matchesChord(event, chord)) {
				handler(event);
				return;
			}
		}
	}

	document.addEventListener("keydown", onKeydown);
	return () => document.removeEventListener("keydown", onKeydown);
}

function noop(): void {}

function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export { DEFAULT_CHORDS as _DEFAULT_CHORDS };
