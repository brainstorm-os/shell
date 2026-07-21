/**
 * Window switcher overlay — keyboard-driven, MRU-ordered, navigable with
 * Tab / arrows. Opened by `Mod+\`` (shell shortcut `shell/switch-window`,
 * registered in `main/shortcuts/shortcut-registry.ts`).
 *
 * Per §Window switcher overlay. This is
 * the v1 "list" mode — `grid` + `mru-strip` come later when the fancy-menus
 * surface lands (Stage 8). Live thumbnails are tracked in OQ-135.
 */

import { useEscapeStackEntry } from "@brainstorm-os/sdk/a11y";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WindowEntry } from "../../shared/window-types";
import { t } from "../i18n/t";
import { useShortcut } from "../shortcuts/use-shortcut";
import { AppIcon } from "./app-icon";

export type WindowSwitcherProps = {
	open: boolean;
	entries: readonly WindowEntry[];
	/** Bumped by the host when the open chord fires while the switcher is
	 *  already open — each bump steps the selection forward (Alt+Tab style). */
	cycle?: number;
	/** Bumped by the reverse chord (Ctrl+Shift+Tab) — steps selection back. */
	cyclePrev?: number;
	/** Bumped when the modifier is released — commits the highlighted window. */
	commitSignal?: number;
	/** When opened via the reverse chord, highlight the most-distant window
	 *  first (last in MRU order) instead of the second-MRU one. */
	reverse?: boolean;
	onFocus: (id: string) => void;
	onClose: () => void;
};

export function WindowSwitcher({
	open,
	entries,
	cycle = 0,
	cyclePrev = 0,
	commitSignal = 0,
	reverse = false,
	onFocus,
	onClose,
}: WindowSwitcherProps) {
	const [selected, setSelected] = useState(0);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const lastCycle = useRef(cycle);
	const lastCyclePrev = useRef(cyclePrev);
	const lastCommit = useRef(commitSignal);

	const list = useMemo(
		() => [...entries].sort((a, b) => b.lastFocusedAt - a.lastFocusedAt),
		[entries],
	);

	useEffect(() => {
		if (!open) return;
		// Default selection: second-MRU entry, so the classic Alt+Tab behaviour
		// (release immediately to switch to the previous window) works out of
		// the box. Reverse-opened, highlight the most-distant (last) window.
		// Falls back to index 0 when there's only one window.
		setSelected(reverse ? Math.max(0, list.length - 1) : list.length > 1 ? 1 : 0);
		requestAnimationFrame(() => panelRef.current?.focus());
	}, [open, list.length, reverse]);

	const commit = useCallback(
		(index: number) => {
			const entry = list[index];
			if (!entry) {
				onClose();
				return;
			}
			onFocus(entry.id);
			onClose();
		},
		[list, onFocus, onClose],
	);

	const stepNext = useCallback(() => {
		if (list.length === 0) return;
		setSelected((s) => (s + 1) % list.length);
	}, [list.length]);
	const stepPrev = useCallback(() => {
		if (list.length === 0) return;
		setSelected((s) => (s - 1 + list.length) % list.length);
	}, [list.length]);
	const commitSelected = useCallback(() => commit(selected), [commit, selected]);

	useEffect(() => {
		if (cycle === lastCycle.current) return;
		lastCycle.current = cycle;
		if (open) stepNext();
	}, [cycle, open, stepNext]);

	useEffect(() => {
		if (cyclePrev === lastCyclePrev.current) return;
		lastCyclePrev.current = cyclePrev;
		if (open) stepPrev();
	}, [cyclePrev, open, stepPrev]);

	useEffect(() => {
		if (commitSignal === lastCommit.current) return;
		lastCommit.current = commitSignal;
		if (open) commitSelected();
	}, [commitSignal, open, commitSelected]);

	const scope = { kind: "scope" as const, ref: panelRef };
	useEscapeStackEntry({ onEscape: onClose, enabled: open, label: "window-switcher" });
	useShortcut("shell/popover.confirm", commitSelected, { target: scope, enabled: open });
	useShortcut("shell/popover.confirm-secondary", commitSelected, { target: scope, enabled: open });
	useShortcut("shell/list.next", stepNext, { target: scope, enabled: open });
	useShortcut("shell/list.next-horizontal", stepNext, { target: scope, enabled: open });
	useShortcut("shell/list.previous", stepPrev, { target: scope, enabled: open });
	useShortcut("shell/list.previous-horizontal", stepPrev, { target: scope, enabled: open });
	useShortcut("shell/list.cycle-next", stepNext, { target: scope, enabled: open });
	useShortcut("shell/list.cycle-previous", stepPrev, { target: scope, enabled: open });

	return (
		<AnimatePresence>
			{open && (
				<motion.div
					key="window-switcher"
					className="window-switcher"
					role="dialog"
					aria-modal="true"
					aria-labelledby="window-switcher-title"
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={{ duration: 0.12 }}
				>
					<button
						type="button"
						className="window-switcher__backdrop"
						onClick={onClose}
						aria-label={t("shell.windowSwitcher.dismiss")}
						tabIndex={-1}
					/>
					<motion.div
						ref={panelRef}
						className="window-switcher__panel"
						tabIndex={-1}
						initial={{ scale: 0.96, opacity: 0 }}
						animate={{ scale: 1, opacity: 1 }}
						exit={{ scale: 0.98, opacity: 0 }}
						transition={{ duration: 0.16, ease: "easeOut" }}
					>
						<header className="window-switcher__header">
							<h2 id="window-switcher-title" className="window-switcher__title">
								{t("shell.windowSwitcher.title")}
							</h2>
							<p className="window-switcher__hint">{t("shell.windowSwitcher.hint")}</p>
						</header>
						{list.length === 0 ? (
							<p className="window-switcher__empty">{t("shell.windowSwitcher.empty")}</p>
						) : (
							<div className="window-switcher__list">
								{list.map((entry, index) => (
									<button
										key={entry.id}
										type="button"
										aria-current={selected === index ? "true" : undefined}
										className={
											selected === index
												? "window-switcher__row window-switcher__row--selected window-switcher__row-button"
												: "window-switcher__row window-switcher__row-button"
										}
										onMouseEnter={() => setSelected(index)}
										onClick={() => commit(index)}
									>
										<AppIcon
											name={entry.appName}
											seed={entry.appId}
											src={`brainstorm://app-icon/${encodeURIComponent(entry.appId)}`}
											size={40}
										/>
										<span className="window-switcher__row-body">
											<span className="window-switcher__row-title">{entry.title || entry.appName}</span>
											<span className="window-switcher__row-subtitle">{entry.appName}</span>
										</span>
										{entry.focused && (
											<span className="window-switcher__row-pill" aria-hidden="true">
												{t("shell.windowSwitcher.currentPill")}
											</span>
										)}
									</button>
								))}
							</div>
						)}
					</motion.div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
