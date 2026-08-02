/**
 * The shared proposal-tray chrome (Tool-8b), extracted from the agent's
 * preview-confirm tray (Agent-11b) at copy two — the `proposes-write` tool
 * tray is the second proposal surface, and doc 78's rung explicitly forbids
 * growing a second one ("two proposal trays is exactly the drift the rules
 * exist to prevent").
 *
 * What is shared is the CHROME: the capped, internally-scrolling tray section
 * with its title/subtitle head, and the card skeleton classes in
 * `proposal-tray.css` (`.bs-proposal`, `__head`, `__kind`, `__fields`,
 * `__field`, `__field-label`, `__input`, `__actions`). What stays app-local is
 * the card CONTENT — the agent's editable drafts and the tool tray's diffs
 * are different bodies over the same skeleton.
 */

import type { ReactElement, ReactNode } from "react";

export type ProposalTraySectionProps = {
	/** Rendered in the tray head, e.g. an `<Icon>`; the SDK ships no glyph
	 *  choice of its own. */
	icon?: ReactNode;
	title: string;
	subtitle?: string;
	/** Accessible name for the tray region; defaults to `title`. */
	ariaLabel?: string;
	children: ReactNode;
	testId?: string;
};

/** The tray wrapper: a bordered, elevation-surfaced section whose height is
 *  capped so however many cards are staged, the surface below it (a composer,
 *  an editor) stays reachable — the lesson the agent tray already learned. */
export function ProposalTraySection({
	icon,
	title,
	subtitle,
	ariaLabel,
	children,
	testId,
}: ProposalTraySectionProps): ReactElement {
	return (
		<section
			className="bs-proposal-tray"
			aria-label={ariaLabel ?? title}
			{...(testId !== undefined ? { "data-testid": testId } : {})}
		>
			<header className="bs-proposal-tray__head">
				<span className="bs-proposal-tray__title">
					{icon}
					{title}
				</span>
				{subtitle !== undefined ? <span className="bs-proposal-tray__subtitle">{subtitle}</span> : null}
			</header>
			{children}
		</section>
	);
}
