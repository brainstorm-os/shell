/**
 * Welcome-menu CTA tile — a flat square button with the icon stacked above the
 * label, so the first-launch menu reads as a launcher grid rather than a stack
 * of glossy buttons. Shared by the inline CTAs (create / open) and the popover
 * entries (join / migrate) so all four tiles stay identical.
 */

import { forwardRef } from "react";
import { Icon, type IconName } from "../ui/icon";

export type WelcomeTileProps = {
	icon: IconName;
	label: string;
	onClick: () => void;
	disabled?: boolean;
	/** Accent-tinted icon chip so the primary action stays visually first. */
	primary?: boolean;
	testId?: string;
};

export const WelcomeTile = forwardRef<HTMLButtonElement, WelcomeTileProps>(function WelcomeTile(
	{ icon, label, onClick, disabled = false, primary = false, testId },
	ref,
) {
	return (
		<button
			ref={ref}
			type="button"
			className={primary ? "welcome__tile welcome__tile--primary" : "welcome__tile"}
			onClick={onClick}
			disabled={disabled}
			data-testid={testId}
		>
			<span className="welcome__tile-icon" aria-hidden="true">
				<Icon name={icon} size={22} />
			</span>
			<span className="welcome__tile-label">{label}</span>
		</button>
	);
});
