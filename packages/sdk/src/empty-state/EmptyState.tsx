/**
 * `<EmptyState>` — the shared "nothing here yet" surface every app uses for an
 * empty list, an unopened pane, or a friendly error: a glyph, a title, an
 * optional hint, and an optional action (a CTA button). Every app renders the
 * same chrome so empties read as siblings instead of each app's own
 * hand-rolled placeholder ([[extract-to-sdk-at-copy-two]] — Preview,
 * Automations and Books all grew their own; this is the one path).
 *
 * Content-only: positioning + the host's background are the consumer's; this
 * fills its host and centres within it. Load the styles once per app:
 * `import "@brainstorm-os/sdk/empty-state.css"`.
 */

import type { ReactElement, ReactNode } from "react";
import { Icon, type IconName } from "../icon";
import { EmptyStateTone, emptyStateClassName } from "./tone";

export interface EmptyStateProps {
	/** The glyph above the title — the domain's universal icon. */
	icon: IconName;
	/** One short line naming what's missing (already localized by the caller). */
	title: string;
	/** Optional second line — what to do about it. Accepts a node so a hint can
	 *  carry inline chrome (a `<kbd>` shortcut, a link). */
	hint?: ReactNode;
	/** Optional action row (typically a `bs-btn` CTA) below the hint. */
	action?: ReactNode;
	/** `Hero` (large accent chip, default) vs `Compact` (small dim glyph). */
	tone?: EmptyStateTone;
	/** Extra layout/positioning classes (never re-skin the surface). */
	className?: string;
}

export function EmptyState({
	icon,
	title,
	hint,
	action,
	tone = EmptyStateTone.Hero,
	className,
}: EmptyStateProps): ReactElement {
	return (
		<div className={emptyStateClassName(tone, className)}>
			<span className="bs-empty-state__glyph" aria-hidden="true">
				<Icon name={icon} size={28} />
			</span>
			<p className="bs-empty-state__title">{title}</p>
			{hint ? <p className="bs-empty-state__hint">{hint}</p> : null}
			{action ? <div className="bs-empty-state__action">{action}</div> : null}
		</div>
	);
}

export { EmptyStateTone };
