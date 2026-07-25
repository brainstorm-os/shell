/**
 * Per-cell property subscriptions (Stage 8.3).
 *
 * A layout renders one cell per property. If the whole view re-rendered
 * on every property write, a form with 40 fields would repaint 40 cells
 * per keystroke — and the freeform / grid modes make that worse, since
 * each cell carries positioning work. So the value layer is a
 * **per-property subscription**: a cell subscribes to its own key and
 * nothing else, and a write to `email` re-renders exactly the `email`
 * cell.
 *
 * The contract is deliberately tiny (`get` + `subscribe`) so the host
 * owns the actual store — a Yjs map in an app, a plain object in the
 * form-designer preview, a fixture in a test. `createLayoutValueSource`
 * is the in-memory implementation those non-Yjs hosts use.
 */

export type LayoutValueSource = {
	/** Current value for a property key (`undefined` ⇒ unset). */
	get(property: string): unknown;
	/** Subscribe to changes for ONE property key. Returns an unsubscribe.
	 *  Called by each cell for its own key — never for the whole entity. */
	subscribe(property: string, onChange: () => void): () => void;
};

export type MutableLayoutValueSource = LayoutValueSource & {
	/** Write one property and notify only that key's subscribers. */
	set(property: string, value: unknown): void;
	/** Replace every value (a fresh entity loaded into the same view) and
	 *  notify only the keys whose value actually changed. */
	reset(values: Readonly<Record<string, unknown>>): void;
	/** A snapshot of all values — for `siblings` on the cell contract, so
	 *  a formula cell can resolve its references. */
	snapshot(): Readonly<Record<string, unknown>>;
};

/**
 * An in-memory `LayoutValueSource`. Notifies per key, and only when the
 * value actually changed (`Object.is`) — a no-op write must not repaint
 * a cell, or an editor that echoes its own value on every keystroke
 * would defeat the point of subscribing per property.
 */
export function createLayoutValueSource(
	initial: Readonly<Record<string, unknown>> = {},
): MutableLayoutValueSource {
	let values: Record<string, unknown> = { ...initial };
	const listeners = new Map<string, Set<() => void>>();

	const notify = (property: string): void => {
		const set = listeners.get(property);
		if (!set) return;
		for (const listener of [...set]) listener();
	};

	return {
		get: (property) => values[property],
		subscribe: (property, onChange) => {
			let set = listeners.get(property);
			if (!set) {
				set = new Set();
				listeners.set(property, set);
			}
			set.add(onChange);
			return () => {
				const current = listeners.get(property);
				if (!current) return;
				current.delete(onChange);
				if (current.size === 0) listeners.delete(property);
			};
		},
		set: (property, value) => {
			if (Object.is(values[property], value)) return;
			values = { ...values, [property]: value };
			notify(property);
		},
		reset: (next) => {
			const previous = values;
			values = { ...next };
			const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
			for (const key of keys) {
				if (!Object.is(previous[key], values[key])) notify(key);
			}
		},
		snapshot: () => values,
	};
}

/** Read-only view over a plain object — the degenerate source for a
 *  static render (print / preview) that never mutates. */
export function staticLayoutValueSource(
	values: Readonly<Record<string, unknown>>,
): LayoutValueSource {
	return {
		get: (property) => values[property],
		subscribe: () => () => {},
	};
}
