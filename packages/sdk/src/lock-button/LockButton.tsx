import type { ReactElement } from "react";
import { Icon, IconName } from "../icon";

export type LockButtonProps = {
	/** Whether the object is locked (read-only). `locked` is a normal synced
	 *  entity property, so locking on one device shows up on every device/peer. */
	locked: boolean;
	/** Toggle handler — persist `!locked` on the entity via the app's update path. */
	onToggle: () => void;
	/** Action label shown when UNLOCKED (the lock action, e.g. "Lock (read-only)"). */
	lockLabel: string;
	/** Action label shown when LOCKED (the unlock action, e.g. "Unlock"). */
	unlockLabel: string;
};

/**
 * Shared header lock toggle. A locked object is read-only: the host app gates
 * its edit surface on `locked` (e.g. `editable={!locked}`) and drops this button
 * into `.app-header__right`. One affordance for the whole fleet so lock looks +
 * behaves identically in every app. Uses the shared `.header-icon-btn` chrome;
 * the locked (`aria-pressed`) state paints accent via `app-theme.css`.
 */
export function LockButton({
	locked,
	onToggle,
	lockLabel,
	unlockLabel,
}: LockButtonProps): ReactElement {
	const label = locked ? unlockLabel : lockLabel;
	return (
		<button
			type="button"
			className="header-icon-btn bs-lock-button"
			aria-pressed={locked}
			aria-label={label}
			title={label}
			data-bs-tooltip={label}
			onClick={onToggle}
		>
			<Icon name={IconName.Lock} />
		</button>
	);
}
