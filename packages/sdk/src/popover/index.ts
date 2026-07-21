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
	DEFAULT_POPOVER_ESCAPE_MATCHER,
	PopoverBodyPadding,
	type PopoverEscapeMatcher,
	PopoverSize,
} from "./popover-shared";
export {
	DEFAULT_POPOVER_LABELS,
	type PopoverLabels,
	resolvePopoverLabels,
} from "./popover-labels";
