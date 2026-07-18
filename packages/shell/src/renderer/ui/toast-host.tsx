/**
 * Toast host — renders the shared toast store (`./toasts`) as transient cards
 * in the bottom-right. Mount `<ToastHost />` once at the renderer root; toasts
 * auto-dismiss and the user can also click ✕.
 */

import { AnimatePresence, motion } from "framer-motion";
import { useSyncExternalStore } from "react";
import { t } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "./button";
import { Icon, IconName } from "./icon";
import { IconButton, IconButtonSize } from "./icon-button";
import { ToastKind, dismissToast, getSnapshot, subscribe } from "./toasts";

const ICONS: Record<ToastKind, IconName> = {
	[ToastKind.Info]: IconName.CheckCircle,
	[ToastKind.Success]: IconName.CheckCircle,
	[ToastKind.Warning]: IconName.Warning,
	[ToastKind.Error]: IconName.Warning,
};

export function ToastHost() {
	const list = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
	return (
		<div className="toasts" aria-live="polite" aria-label={t("shell.toasts.region")}>
			<AnimatePresence initial={false}>
				{list.map((toast) => (
					<motion.div
						key={toast.id}
						className={`toast toast--${toast.kind} glass`}
						role={toast.kind === ToastKind.Error ? "alert" : "status"}
						initial={{ opacity: 0, x: 16, scale: 0.96 }}
						animate={{ opacity: 1, x: 0, scale: 1 }}
						exit={{ opacity: 0, x: 16, scale: 0.96 }}
						transition={{ duration: 0.18, ease: "easeOut" }}
					>
						<span className="toast__icon" aria-hidden="true">
							<Icon name={ICONS[toast.kind]} size={18} />
						</span>
						<div className="toast__body">
							<p className="toast__title">{toast.title}</p>
							{toast.body && <p className="toast__detail">{toast.body}</p>}
							{toast.action && (
								<div className="toast__action">
									<Button
										variant={ButtonVariant.Primary}
										size={ButtonSize.Md}
										onClick={() => {
											toast.action?.onPress();
											dismissToast(toast.id);
										}}
									>
										{toast.action.label}
									</Button>
								</div>
							)}
						</div>
						<IconButton
							icon={IconName.Close}
							label={t("shell.actions.close")}
							size={IconButtonSize.Sm}
							onClick={() => dismissToast(toast.id)}
						/>
					</motion.div>
				))}
			</AnimatePresence>
		</div>
	);
}
