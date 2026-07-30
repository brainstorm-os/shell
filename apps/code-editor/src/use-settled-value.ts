/**
 * React side of the quiet-period coalescer (`logic/settle.ts`) — the hook the
 * inspector derivations read instead of the live buffer.
 */

import { useEffect, useState } from "react";

/**
 * `value`, held back until it has stopped changing for `delayMs`. Between a
 * change and the settle the PREVIOUS value keeps flowing, so a consumer never
 * sees a gap: the panel it feeds keeps its rendered content instead of
 * blanking to an empty state mid-edit.
 *
 * `flushKey` bypasses the wait. When the identity behind the value changes (a
 * different file), the held value isn't merely late — it belongs to something
 * else, and showing it for a quarter second would be wrong.
 */
export function useSettledValue<T>(value: T, delayMs: number, flushKey: unknown): T {
	const [settled, setSettled] = useState<{ key: unknown; value: T }>({ key: flushKey, value });
	// Adjusting state during render (React's sanctioned derived-state pattern):
	// a `useEffect` flush would paint one frame of the previous file's results.
	if (settled.key !== flushKey) setSettled({ key: flushKey, value });
	const current = settled.key === flushKey ? settled.value : value;

	useEffect(() => {
		if (Object.is(current, value)) return;
		const timer = setTimeout(() => setSettled({ key: flushKey, value }), delayMs);
		return () => clearTimeout(timer);
	}, [current, value, flushKey, delayMs]);

	return current;
}
