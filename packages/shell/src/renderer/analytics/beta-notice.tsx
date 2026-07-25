import {
	hasDismissedBetaAnalyticsNotice,
	isPublicBeta,
	markBetaAnalyticsNoticeDismissed,
} from "@brainstorm-os/sdk/analytics";
import { AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";
import { t } from "../i18n/t";
import { useShortcut } from "../shortcuts/use-shortcut";
import { Button, ButtonVariant } from "../ui/button";
import { Popover } from "../ui/popover";
import { PopoverBodyPadding, PopoverSize } from "../ui/popover-types";
import { useVaultMaybe } from "../vault-context";

export type AnalyticsBetaNoticeProps = {
	/** Gate: the notice waits for a vault. See `AnalyticsBetaNoticeHost`. */
	vaultOpen: boolean;
};

/** One-time disclosure while the product is in public beta and analytics is on. */
export function AnalyticsBetaNotice({ vaultOpen }: AnalyticsBetaNoticeProps) {
	const [open, setOpen] = useState(false);

	useEffect(() => {
		// The welcome screen owns first launch. This is a modal centred over the
		// viewport, so opening it there lands it on top of the create / open /
		// join tiles and the very first thing a new install shows is an
		// analytics disclosure blocking the only actions available.
		if (!vaultOpen) return;
		const version = window.brainstorm?.version ?? "0.0.0";
		if (!isPublicBeta(version)) return;
		if (hasDismissedBetaAnalyticsNotice()) return;
		setOpen(true);
	}, [vaultOpen]);

	const dismiss = () => {
		markBetaAnalyticsNoticeDismissed();
		setOpen(false);
	};

	useShortcut("shell/popover.confirm", dismiss, { enabled: open });

	return (
		<AnimatePresence mode="wait">
			{open && (
				<Popover
					key="analytics-beta-notice"
					title={t("shell.analytics.betaNotice.title")}
					onClose={dismiss}
					size={PopoverSize.Medium}
					bodyPadding={PopoverBodyPadding.Comfortable}
					testId="analytics-beta-notice"
					footer={
						<Button
							variant={ButtonVariant.Primary}
							onClick={dismiss}
							data-testid="analytics-beta-notice-dismiss"
						>
							{t("shell.analytics.betaNotice.dismiss")}
						</Button>
					}
				>
					<p>{t("shell.analytics.betaNotice.body")}</p>
					<p className="settings__section-summary">{t("shell.analytics.betaNotice.detail")}</p>
				</Popover>
			)}
		</AnimatePresence>
	);
}

/** Mount point: reads the live vault so the notice waits for one. Tolerant of a
 *  missing provider (dev HMR) — no vault context means no vault, so no modal. */
export function AnalyticsBetaNoticeHost() {
	const vault = useVaultMaybe();
	return <AnalyticsBetaNotice vaultOpen={vault?.current != null} />;
}
