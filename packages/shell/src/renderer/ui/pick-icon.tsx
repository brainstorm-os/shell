/**
 * Imperative `pickIcon()` API + `<IconPickerHost />` mount. Mirrors the
 * confirm-dialog pattern (`confirm()` + `<ConfirmHost />`): one host
 * mounted at the app root, any call site requests a picker via
 * `pickIcon(currentValue)` and awaits the user's choice.
 *
 * Resolution:
 *   - `Icon`         — user picked an icon
 *   - `null`         — user clicked "Remove icon"
 *   - `undefined`    — user dismissed (Escape / click outside / cancel)
 */

import type { Icon } from "@brainstorm-os/sdk-types";
import { useSyncExternalStore } from "react";
import { IconPicker } from "./icon-picker";

type Resolution = Icon | null | undefined;

type Request = {
	id: string;
	initial: Icon | null;
	resolve: (result: Resolution) => void;
};

let queue: readonly Request[] = [];
const listeners = new Set<() => void>();

function emit(): void {
	for (const fn of listeners) fn();
}

function subscribe(onChange: () => void): () => void {
	listeners.add(onChange);
	return () => {
		listeners.delete(onChange);
	};
}

function getSnapshot(): readonly Request[] {
	return queue;
}

export function pickIcon(initial: Icon | null = null): Promise<Resolution> {
	return new Promise<Resolution>((resolve) => {
		const id = `ip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
		queue = [...queue, { id, initial, resolve }];
		emit();
	});
}

function respond(id: string, result: Resolution): void {
	const target = queue.find((r) => r.id === id);
	if (!target) return;
	queue = queue.filter((r) => r.id !== id);
	emit();
	target.resolve(result);
}

export function IconPickerHost() {
	const list = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
	const current = list[0];
	if (!current) return null;
	return (
		<IconPicker
			value={current.initial}
			onChange={(icon) => respond(current.id, icon)}
			onClose={() => respond(current.id, undefined)}
		/>
	);
}
