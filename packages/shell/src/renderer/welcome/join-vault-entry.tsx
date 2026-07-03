/**
 * Welcome → "Join an existing vault" entry (Stage 10.5b — pairing UX).
 *
 * Sits next to the "Create new vault" / "Open existing vault" CTAs on the
 * first-launch screen. Opens the shared `<DevicesJoinFlow>` inside a
 * `<Popover>` so the flow chrome is identical to the Settings-side path.
 *
 * Reachable BEFORE any vault exists — that's the whole point. The pairing
 * service requires an active vault session today, so this entry surfaces
 * the UX but the wire-up that actually instantiates a target vault from
 * the join handshake lands at 10.5c.
 */

import { AnimatePresence } from "framer-motion";
import { Suspense, lazy, useState } from "react";
import { t } from "../i18n/t";
// Lazy-load to match the Settings-side split — the join flow only mounts when
// the user explicitly opens the popover, and shares a chunk with the same
// import from `settings/settings.tsx`.
const DevicesJoinFlow = lazy(() =>
	import("../settings/devices-join-flow").then((m) => ({ default: m.DevicesJoinFlow })),
);
import { IconName } from "../ui/icon";
import { Popover } from "../ui/popover";
import { PopoverBodyPadding, PopoverSize } from "../ui/popover-types";
import { WelcomeTile } from "./welcome-tile";

export type JoinVaultEntryProps = {
	disabled?: boolean;
};

export function JoinVaultEntry({ disabled = false }: JoinVaultEntryProps) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<WelcomeTile
				icon={IconName.DeviceMobile}
				label={t("shell.welcome.joinVault.cta")}
				onClick={() => setOpen(true)}
				disabled={disabled}
				testId="welcome-join-vault"
			/>
			<AnimatePresence>
				{open && (
					<Popover
						title={t("shell.settings.devices.join.title")}
						size={PopoverSize.Small}
						bodyPadding={PopoverBodyPadding.Comfortable}
						onClose={() => setOpen(false)}
						testId="welcome-join-vault-popover"
					>
						<Suspense fallback={null}>
							<DevicesJoinFlow onClose={() => setOpen(false)} embedded />
						</Suspense>
					</Popover>
				)}
			</AnimatePresence>
		</>
	);
}
