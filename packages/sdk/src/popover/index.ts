/**
 * `@brainstorm-os/sdk/popover` — the app-side dialog/popover primitive.
 * `<Popover>` (React) and `createPopoverElement` (pure DOM) give an app the
 * same glass-overlay chrome the shell's shared `<Popover>` does, on the
 * same call-site contract (title / onClose / children / footer? / size? /
 * bodyPadding?). No framer-motion.
 */

export { Popover, type PopoverProps } from "./popover";
export {
	createPopoverElement,
	type CreatePopoverOptions,
	type PopoverHandle,
} from "./create-popover-element";
export {
	computeAnchoredPopoverPosition,
	DEFAULT_POPOVER_ESCAPE_MATCHER,
	POPOVER_ANCHOR_GUTTER,
	POPOVER_VIEWPORT_MARGIN,
	PopoverAlign,
	type PopoverAnchorRect,
	PopoverBodyPadding,
	type PopoverBoxSize,
	type PopoverEscapeMatcher,
	type PopoverPosition,
	PopoverSize,
} from "./popover-shared";
export {
	DEFAULT_POPOVER_LABELS,
	type PopoverLabels,
	resolvePopoverLabels,
} from "./popover-labels";
