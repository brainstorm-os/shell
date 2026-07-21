/**
 * `@brainstorm-os/sdk/shortcut` — the host-agnostic keyboard layer. Apps bind
 * a chord (the same chord syntax the shell registry uses) instead of
 * scattering raw `e.key` checks. `attachShortcut` is the pure-DOM binder;
 * `useShortcut` is the React twin; `matchesChord`/`normalizeKey` are the
 * shared parser (ported verbatim from the shell hook).
 */

export { chordIsSingleKey, matchesChord, normalizeKey } from "./chord";
export { isEditableElement } from "./is-editable";
export {
	isAnyShortcutSuppressed,
	registerShortcutSuppression,
	type ShortcutSuppressionSource,
} from "./suppression";
export {
	attachShortcut,
	type ShortcutDisposer,
	type ShortcutOptions,
} from "./attach-shortcut";
export {
	useShortcut,
	type UseShortcutOptions,
	type UseShortcutTarget,
} from "./use-shortcut";
