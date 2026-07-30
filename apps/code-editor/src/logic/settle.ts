/**
 * Quiet-period coalescing for the derivations hanging off the code buffer
 * (the references panel, the problem list, the inline squiggles).
 *
 * Every keystroke rewrites the buffer, and each of those derivations is a
 * whole-buffer scan whose output then repaints a panel. Running them per
 * character made the inspector rebuild itself continuously while typing —
 * visible as a blink. They are *reference* surfaces, not the text itself:
 * being a quarter second behind the caret is unnoticeable, whereas being
 * rebuilt sixty times a second is not.
 */

/**
 * Trailing quiet period before a buffer-derived surface recomputes.
 *
 * 250 ms sits above a fluent typist's inter-keystroke gap (~120–200 ms at
 * 60–100 wpm), so a continuous burst collapses into exactly one recompute,
 * and below the ~300 ms mark where a post-pause update stops reading as a
 * direct consequence of having stopped typing.
 */
export const EDIT_SETTLE_MS = 250;

export interface TrailingCoalescer {
	/** Run `task` once the calls stop for the configured delay. A new call
	 *  supersedes the pending one — only the last task runs. */
	schedule(task: () => void): void;
	/** Drop the pending task (dispose / buffer swap). */
	cancel(): void;
}

export function createTrailingCoalescer(delayMs: number): TrailingCoalescer {
	let timer: ReturnType<typeof setTimeout> | null = null;
	return {
		schedule(task) {
			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				task();
			}, delayMs);
		},
		cancel() {
			if (timer === null) return;
			clearTimeout(timer);
			timer = null;
		},
	};
}
