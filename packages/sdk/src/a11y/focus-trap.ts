/**
 * `@brainstorm-os/sdk/a11y` focus-trap stack — the pure stack-bookkeeping half
 * of `useFocusTrap`. NO DOM. KBN-1b will sit on top of this and own the
 * inert-siblings / initial-focus / restore-on-close DOM work.
 *
 * Why a stack at all: modals are nestable (a confirmation prompt fired from
 * inside a settings dialog, the cap-prompt opened from inside the launcher).
 * The Escape stack (KBN-2) needs to pop topmost-first and restore focus to
 * the *previous* trap's opener, not to `<body>`. That ordering is fragile to
 * get right when traps unmount in arbitrary order — the stack maintains the
 * LIFO ordering for IDs that are still present, even when a non-top entry
 * is yanked out (a route change unmounting a middle modal while the topmost
 * is still alive).
 */

export type FocusTrapEntry = {
	readonly id: string;
	readonly openerLabel?: string;
	readonly onEscape: () => void;
};

export interface FocusTrapStack {
	push(entry: FocusTrapEntry): () => void;
	peek(): FocusTrapEntry | null;
	popTop(): FocusTrapEntry | null;
	size(): number;
	clear(): void;
}

export function createFocusTrapStack(): FocusTrapStack {
	const stack: FocusTrapEntry[] = [];

	const remove = (id: string): void => {
		// Walk back-to-front so an in-flight LIFO pop is consistent with an
		// out-of-order unmount; we only pop the FIRST matching id (push uses
		// caller-provided ids — duplicates would be a caller bug).
		for (let i = stack.length - 1; i >= 0; i--) {
			if ((stack[i] as FocusTrapEntry).id === id) {
				stack.splice(i, 1);
				return;
			}
		}
	};

	return {
		push(entry) {
			stack.push(entry);
			return () => remove(entry.id);
		},
		peek() {
			return stack.length === 0 ? null : (stack[stack.length - 1] as FocusTrapEntry);
		},
		popTop() {
			return stack.length === 0 ? null : (stack.pop() ?? null);
		},
		size() {
			return stack.length;
		},
		clear() {
			stack.length = 0;
		},
	};
}

/**
 * Convenience for the Escape-stack (KBN-2) hand-off: peek the top entry, run
 * its `onEscape`, return whether an entry actually existed. The host owns
 * removal — `onEscape` is expected to call the unsubscribe returned from
 * `push()` once it decides to close. This lets a modal veto its own dismiss
 * (e.g. unsaved-changes guard returning early without popping) and keeps the
 * stack consistent if `onEscape` throws. Errors propagate; the caller decides
 * whether to swallow them.
 *
 * Re-entrancy footgun: the host MUST remove its entry (via the unsubscribe
 * from `push()`) before its `onEscape` returns, OR before calling `applyEscape`
 * again recursively. Otherwise `peek()` keeps returning the same top entry
 * forever and a chained `applyEscape` recurses indefinitely.
 */
export function applyEscape(stack: FocusTrapStack): boolean {
	const top = stack.peek();
	if (top === null) return false;
	top.onEscape();
	return true;
}
