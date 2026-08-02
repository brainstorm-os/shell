/**
 * `@brainstorm-os/sdk/popover` — the app-side dialog/popover, mirroring the
 * shell's shared `<Popover>` call-site contract (`title` / `onClose` /
 * `children` / `footer?` / `size?` / `bodyPadding?` / `testId?`) so an
 * app's overlay chrome looks and behaves like the shell's: glass panel,
 * fixed 44px header, dismiss on backdrop and Escape.
 *
 * No framer-motion (the SDK must not add it): the entrance/exit is a CSS
 * opacity transition on the backdrop only (`popover.css`), matching the
 * shell's pragmatic "don't animate the blurred panel" choice. Escape goes
 * through the centralised matcher seam in `./popover-shared`, never a raw
 * inline `e.key` here. Strings come from injected labels.
 */

import {
	type CSSProperties,
	type ReactNode,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createIconElement } from "../icon/create-icon-element";
import { IconName } from "../icon/icon-registry";
import { type PopoverLabels, resolvePopoverLabels } from "./popover-labels";
import {
	DEFAULT_POPOVER_ESCAPE_MATCHER,
	PopoverAlign,
	PopoverBodyPadding,
	type PopoverEscapeMatcher,
	type PopoverPosition,
	PopoverSize,
	computeAnchoredPopoverPosition,
} from "./popover-shared";
import "./popover.css";

export type PopoverProps = {
	title: ReactNode;
	onClose: () => void;
	children: ReactNode;
	/** Optional action row pinned to the bottom (e.g. Cancel / Confirm). */
	footer?: ReactNode;
	size?: PopoverSize;
	bodyPadding?: PopoverBodyPadding;
	/** Escape predicate, or `null` to leave Escape to the consumer.
	 *  Default: bare-Escape via the shared matcher seam. */
	escapeMatcher?: PopoverEscapeMatcher | null;
	labels?: Partial<PopoverLabels>;
	/** Trigger element to anchor to. When set the panel is positioned off the
	 *  trigger's live rect (the click-anchored menu the repo's menus use)
	 *  instead of centring itself as a modal, and the backdrop stops dimming
	 *  — a menu hanging off a toolbar button, not a dialog. */
	anchor?: HTMLElement | null;
	/** Which trigger edge the panel lines up with. Default `End` (right
	 *  edges flush), matching the header ⋯ menus. */
	anchorAlign?: PopoverAlign;
	/** Test hook for the panel root. */
	testId?: string;
};

/** Pre-measure placement: off-screen so the panel never paints centred for a
 *  frame before the layout effect measures it (the `useAnchoredPanel`
 *  convention). */
const OFFSCREEN_POSITION: PopoverPosition = { top: -9999, left: -9999 };

function CloseGlyph() {
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		const host = ref.current;
		if (!host) return;
		host.replaceChildren(createIconElement(IconName.Close, { size: 18 }));
	}, []);
	return <span ref={ref} className="bs-popover__close-glyph" aria-hidden="true" />;
}

export function Popover({
	title,
	onClose,
	children,
	footer,
	size = PopoverSize.Medium,
	bodyPadding = PopoverBodyPadding.Compact,
	escapeMatcher = DEFAULT_POPOVER_ESCAPE_MATCHER,
	labels,
	anchor = null,
	anchorAlign = PopoverAlign.End,
	testId,
}: PopoverProps) {
	const titleId = useId();
	const l = resolvePopoverLabels(labels);
	const panelRef = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState<PopoverPosition>(OFFSCREEN_POSITION);

	useLayoutEffect(() => {
		if (!anchor) return;
		function place() {
			const panel = panelRef.current;
			if (!panel) return;
			const trigger = anchor?.getBoundingClientRect();
			if (!trigger) return;
			const box = panel.getBoundingClientRect();
			setPosition(
				computeAnchoredPopoverPosition(
					trigger,
					{ width: box.width, height: box.height },
					{ width: window.innerWidth, height: window.innerHeight },
					anchorAlign,
				),
			);
		}
		place();
		window.addEventListener("resize", place);
		return () => window.removeEventListener("resize", place);
	}, [anchor, anchorAlign]);

	useEffect(() => {
		if (escapeMatcher === null) return;
		function onKeyDown(event: KeyboardEvent) {
			if (event.defaultPrevented) return;
			if (escapeMatcher?.(event)) {
				event.preventDefault();
				onClose();
			}
		}
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [escapeMatcher, onClose]);

	const anchored = anchor !== null;
	const panelStyle: CSSProperties | undefined = anchored
		? { position: "fixed", top: position.top, left: position.left }
		: undefined;

	return (
		<div
			className={anchored ? "bs-popover bs-popover--anchored" : "bs-popover"}
			role="dialog"
			aria-modal={anchored ? undefined : true}
			aria-labelledby={titleId}
			aria-label={l.region}
		>
			<button
				type="button"
				className="bs-popover__backdrop"
				onClick={onClose}
				aria-label={l.close}
				tabIndex={-1}
			/>
			<div
				ref={panelRef}
				className={`bs-popover__panel bs-popover__panel--${size}`}
				style={panelStyle}
				data-anchored={anchored ? "true" : undefined}
				data-testid={testId}
			>
				<header className="bs-popover__header">
					<h2 id={titleId} className="bs-popover__title">
						{title}
					</h2>
					<button type="button" className="bs-popover__close" onClick={onClose} aria-label={l.close}>
						<CloseGlyph />
					</button>
				</header>
				<div className={`bs-popover__body bs-popover__body--${bodyPadding}`}>{children}</div>
				{footer && <footer className="bs-popover__footer">{footer}</footer>}
			</div>
		</div>
	);
}
