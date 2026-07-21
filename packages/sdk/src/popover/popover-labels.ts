/**
 * Popover chrome strings. Same labels-injection convention as
 * `@brainstorm-os/sdk/i18n` (`common-labels.ts`): hosts pass nothing for the
 * canonical English; a localised host passes a `Partial<PopoverLabels>` of
 * just the keys it translates. No bare strings live inside the component —
 * it reads everything from a merged labels object.
 */

export type PopoverLabels = {
	/** `aria-label` for the dialog region (used when `title` is a node). */
	region: string;
	/** Close affordance label (header button + backdrop). */
	close: string;
};

export const DEFAULT_POPOVER_LABELS: PopoverLabels = {
	region: "Dialog",
	close: "Close",
};

export function resolvePopoverLabels(overrides?: Partial<PopoverLabels>): PopoverLabels {
	return overrides ? { ...DEFAULT_POPOVER_LABELS, ...overrides } : DEFAULT_POPOVER_LABELS;
}
