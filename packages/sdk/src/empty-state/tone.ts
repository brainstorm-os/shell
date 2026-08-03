/**
 * Pure tone selector for the shared `<EmptyState>` so the class string lives
 * in one place (mirrors `count-badge/format-count.ts`). No DOM, no React.
 */

/** Visual weight of an empty state. Enum, not a bare literal, per the
 *  no-string-discriminator convention. */
export enum EmptyStateTone {
	/** Full-pane first-impression empty — a large accent-tinted glyph chip
	 *  over a title + hint. The default; used when the empty IS the surface
	 *  (Preview's stage, Books' reader pane). */
	Hero = "hero",
	/** In-panel list/section empty — a small dim glyph, no chip. Used when
	 *  the empty sits inside other chrome (Automations' runs/reminders lists). */
	Compact = "compact",
	/** NOT an empty state — a notice that content is MISSING. Warning-tinted
	 *  and sized to sit WITH the surface rather than replace it, because a
	 *  damaged document stays open and editable: taking the pane away would
	 *  stop the user writing new entries, which still save fine. Use only
	 *  where content was lost, never where it merely does not exist yet — the
	 *  whole point is that a user can tell the two apart, which they could not
	 *  when a document that lost writing rendered as a blank page (3.12 /
	 *  F-491). */
	Damaged = "damaged",
}

/** The class string for an empty state at a given tone (+ optional extra
 *  layout classes the consumer owns — never re-skin the surface). */
export function emptyStateClassName(tone: EmptyStateTone, extra?: string): string {
	const base = `bs-empty-state bs-empty-state--${tone}`;
	return extra ? `${base} ${extra}` : base;
}
