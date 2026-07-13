import {
	hasDismissedBetaAnalyticsNotice,
	isPublicBeta,
	markBetaAnalyticsNoticeDismissed,
} from "@brainstorm/sdk/analytics";
import { AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";
import { t } from "../i18n/t";
import { useShortcut } from "../shortcuts/use-shortcut";
import { Button, ButtonVariant } from "../ui/button";
import { Popover } from "../ui/popover";
import { PopoverBodyPadding, PopoverSize } from "../ui/popover-types";

/** One-time disclosure while the product is in public beta and analytics is on. */
export function AnalyticsBetaNotice() {
	const [open, setOpen] = useState(false);

	useEffect(() => {
		const version = window.brainstorm?.version ?? "0.0.0";
		if (!isPublicBeta(version)) return;
		if (hasDismissedBetaAnalyticsNotice()) return;
		setOpen(true);
	}, []);

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