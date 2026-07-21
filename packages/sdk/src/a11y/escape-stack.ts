/**
 * `@brainstorm-os/sdk/a11y` escape stack — the renderer-wide LIFO of overlay
 * closers and the one document-level `Escape` listener that drains them.
 *
 * Builds on KBN-1a:
 *   - `createFocusTrapStack` owns the LIFO bookkeeping (push / peek / popTop
 *     / out-of-order removal).
 *   - `applyEscape` is the safe top-of-stack invoker that lets a host veto its
 *     own dismiss (unsaved-changes guard) by not calling its `off()`.
 *
 * Why one module-scope stack per renderer (resolves OQ-KBN-3):
 *   - Per-window scope mirrors the focus model; a popover in window A must NOT
 *     swallow `Escape` in window B.
 *   - No main-process round-trip — `Escape` latency stays at the cost of a
 *     synchronous document event.
 *   - `useFocusTrap` already pushes here so trap pushes and ad-hoc closers
 *     share one LIFO (a focus-trapped dialog opened from inside a popover
 *     unwinds in the right order).
 *
 * Empty-stack fallthrough: when no entry sits on the stack, the handler does
 * NOT preventDefault, so the chord registry's `app/escape` (or any other
 * Escape-bound chord) fires as it does today. Callers may opt into a
 * `onEmptyStack` callback for telemetry / focus-restoration but routing the
 * Escape verb to the focused app is the chord registry's job, not ours.
 */

import { type FocusTrapStack, applyEscape, createFocusTrapStack } from "./focus-trap";

export type { FocusTrapEntry as EscapeStackEntry } from "./focus-trap";

const moduleStack: FocusTrapStack = createFocusTrapStack();

export function getEscapeStack(): FocusTrapStack {
	return moduleStack;
}

export type InstallEscapeHandlerOptions = {
	onEmptyStack?: () => void;
};

/**
 * Install ONE document-level `keydown` listener (capture phase) that routes
 * `Escape` to the top of `stack`. When an entry was on top, the event is
 * `preventDefault`'d and `stopPropagation`'d so the chord registry can't
 * double-fire `app/escape` over the same press. When the stack is empty,
 * `onEmptyStack` is invoked and the event continues propagating so the chord
 * registry's existing Escape bindings take over.
 *
 * Returns an `uninstall` callback. Idempotent inside StrictMode: a
 * double-mount installs then uninstalls cleanly.
 */
export function installEscapeHandler(
	stack: FocusTrapStack,
	options: InstallEscapeHandlerOptions = {},
): () => void {
	if (typeof document === "undefined") return () => {};

	const onKeyDown = (event: KeyboardEvent): void => {
		if (event.key !== "Escape") return;
		if (event.defaultPrevented) return;
		if (stack.size() === 0) {
			options.onEmptyStack?.();
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		applyEscape(stack);
	};

	document.addEventListener("keydown", onKeyDown, true);
	return () => document.removeEventListener("keydown", onKeyDown, true);
}
