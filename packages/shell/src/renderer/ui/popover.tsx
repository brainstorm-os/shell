/**
 * Shared dialog / popover primitive. Every overlay surface in the renderer
 * uses this so backdrops, panels, headers, close affordances and shadows
 * stay consistent — per CLAUDE.md ("Popovers / dialogs use the shared
 * `<Popover>` primitive").
 *
 * Structure mirrors every other panel surface in the app:
 *   - Header (44px fixed, title + close, project rule "panel headers share
 *     a fixed height")
 *   - Body (flex, scrollable)
 *   - Footer (optional, e.g. confirm / cancel action row)
 *
 * Wiring:
 *   - Backdrop = `var(--color-dimmer)` so dashboard content shows through.
 *   - Panel is a glass surface — applies `.glass` from styles.css (default
 *     density) so wallpaper / background read through with a tinted blur.
 *   - A popover opened from INSIDE another popover (a confirm fired from a
 *     picker dialog) is *stacked*: it drops the glass for an opaque panel,
 *     blurs its own backdrop, lifts its z-index, and renders the popover
 *     beneath it `inert`. See `./popover-stack` for why. A lone popover is
 *     untouched — glass stays glass.
 *   - Focus / Escape / Tab-wrap routes through `useFocusTrap` (KBN-1b on top
 *     of KBN-2's shared escape stack). The opener is captured via a
 *     `useState` lazy initializer at the FIRST render, before any effect, so
 *     `restoreFocusTo` resolves to the element that triggered the popover —
 *     no popover ever leaves focus on `<body>` when it closes (KBN-S-popover).
 *   - Every label flows through `t()`.
 *
 * Stage 8 will swap the implementation onto `react-aria-components` /
 * `@react-fancy-menus/core`; the call-site contract stays.
 */

import { InitialFocusMode, useFocusTrap } from "@brainstorm-os/sdk/a11y";
import { motion } from "framer-motion";
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n/t";
import { IconName } from "./icon";
import { IconButton } from "./icon-button";
import {
	MAX_STACKED_POPOVER_LIFT,
	getPopoverStackIds,
	registerPopover,
	stackDepthOf,
	subscribePopoverStack,
} from "./popover-stack";
import { PopoverBodyPadding, type PopoverProps, PopoverSize } from "./popover-types";
import "./popover.css";

export type { PopoverProps } from "./popover-types";

export function Popover({
	title,
	onClose,
	children,
	footer,
	size = PopoverSize.Medium,
	bodyPadding = PopoverBodyPadding.Compact,
	initialFocusRef,
	fitContent = false,
	testId,
}: PopoverProps) {
	const titleId = useId();
	const stackId = useId();
	const rootRef = useRef<HTMLDivElement | null>(null);
	// Depth is read from the same module state the mount effect below pushes
	// onto: before registration it resolves to the depth this popover is about
	// to land on, so the stacked styling is right on the FIRST paint (no
	// un-stacked flash), and it un-stacks again if the dialog underneath
	// closes first. See ./popover-stack.
	const stackIds = useSyncExternalStore(
		subscribePopoverStack,
		getPopoverStackIds,
		getPopoverStackIds,
	);
	const depth = stackDepthOf(stackIds, stackId);
	const stacked = depth > 0;

	useLayoutEffect(() => {
		const element = rootRef.current;
		if (element === null) return;
		return registerPopover(stackId, element);
	}, [stackId]);

	// Capture the opener at first render — lazy init runs ONCE, synchronously,
	// before useFocusTrap's effect moves focus into the panel. Without an
	// explicit `restoreFocusTo` the hook's default capture would still work,
	// but the explicit pass keeps KBN-G-focus-trap-without-restore happy and
	// makes the restoration target legible at the call site.
	const [opener] = useState<HTMLElement | null>(() => {
		if (typeof document === "undefined") return null;
		return (document.activeElement as HTMLElement | null) ?? null;
	});
	const { containerProps } = useFocusTrap({
		enabled: true,
		onEscape: onClose,
		restoreFocusTo: opener,
		openerLabel: "popover",
		...(initialFocusRef
			? { initialFocus: InitialFocusMode.Explicit, explicitInitialFocus: initialFocusRef }
			: {}),
	});

	const sizeClass = `popover__panel--${size}`;
	const fitClass = fitContent ? " popover__panel--fit" : "";
	const bodyClass = `popover__body popover__body--${bodyPadding}`;
	// A stacked panel swaps `.glass` for an opaque surface: glass samples the
	// dialog beneath it, and two dialogs' worth of body text composited into one
	// layer is unreadable. Lone popovers keep the glass look untouched.
	const surfaceClass = stacked ? "popover__panel--solid" : "glass";
	const lift = Math.min(depth, MAX_STACKED_POPOVER_LIFT);

	const node = (
		// Animation strategy, pragmatic to Chromium's behaviour:
		//
		// - Backdrop fades in normally — it has no blur, so it can animate
		//   freely without GPU contention.
		// - Panel uses `initial={false}` to **skip the entrance animation**.
		//   Chromium defers `backdrop-filter` during opacity transitions on a
		//   freshly-mounted blurred surface; the blur snaps in *after* the
		//   animation completes (visible glitch). Mounting the panel directly
		//   at its target state gives the blur a single quiet first-paint
		//   frame to compute, no animation racing it.
		// - Panel exit *does* animate — the GPU compositor layer is already
		//   warm from the open, so the blur fades cleanly with the panel.
		<div
			ref={rootRef}
			className={`popover${stacked ? " popover--stacked" : ""}`}
			data-bs-region="popover"
			data-popover-depth={depth}
			{...(lift > 0 ? { style: { zIndex: `calc(var(--z-popover) + ${lift})` } } : {})}
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
		>
			<motion.button
				type="button"
				className="popover__backdrop"
				data-bs-region="popover-backdrop"
				onClick={onClose}
				aria-label={t("shell.actions.close")}
				tabIndex={-1}
				// Stacked backdrops carry a `backdrop-filter` so the dialog beneath
				// reads as a soft wash rather than competing text. Chromium defers
				// the blur while a freshly-mounted blurred surface animates opacity
				// (the same glitch the panel dodges below), so a stacked backdrop
				// mounts straight at its target state; exit still animates.
				initial={stacked ? false : { opacity: 0 }}
				animate={{ opacity: 1 }}
				exit={{ opacity: 0 }}
				transition={{ type: "spring", stiffness: 700, damping: 50, mass: 0.5 }}
			/>
			<motion.div
				{...containerProps}
				className={`popover__panel ${surfaceClass} ${sizeClass}${fitClass}`}
				data-bs-region="popover-panel"
				data-testid={testId}
				initial={false}
				animate={{ opacity: 1 }}
				exit={{ opacity: 0 }}
				transition={{ type: "spring", stiffness: 700, damping: 40, mass: 0.45 }}
			>
				<header className="popover__header">
					<h2 id={titleId} className="popover__title">
						{title}
					</h2>
					<IconButton icon={IconName.Close} label={t("shell.actions.close")} onClick={onClose} />
				</header>
				<div className={bodyClass}>{children}</div>
				{footer && <footer className="popover__footer">{footer}</footer>}
			</motion.div>
		</div>
	);

	// Portal to <body> so the popover escapes any transformed / overflow-hidden
	// ancestor (Settings + Help slide-in via framer-motion `animate={{ x: 0 }}`,
	// which keeps an inline `transform` that reframes `position: fixed` to the
	// panel and clips it). SSR string-render path (node env, no `document`)
	// falls through inline so the existing renderToStaticMarkup tests keep
	// asserting against `class="popover"` markup.
	if (typeof document === "undefined" || !document.body) return node;
	return createPortal(node, document.body);
}
