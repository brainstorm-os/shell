/**
 * Toast store — a tiny external store that any screen pushes into. The visual
 * surface lives in `./toast-host` (`<ToastHost />`, mounted once at the
 * renderer root). Split from the component so the store + enum keep a stable
 * import path (`@renderer/ui/toasts`) and the host file stays Fast-Refresh
 * compatible (a component module that exports only the component).
 *
 * Usage:
 *   import { pushToast, ToastKind } from "@renderer/ui/toasts";
 *   pushToast({ kind: ToastKind.Error, title: "Couldn't open vault", body: err.message });
 *
 * Pure DRY surface — every screen pushes to the same store; no per-screen
 * toast component duplication.
 */

export enum ToastKind {
	Info = "info",
	Success = "success",
	Warning = "warning",
	Error = "error",
}

/** An optional call-to-action rendered as a button inside the toast.
 *  Pressing it runs `onPress` and dismisses the toast. */
export type ToastAction = {
	label: string;
	onPress: () => void;
};

export type Toast = {
	id: string;
	kind: ToastKind;
	title: string;
	body?: string;
	action?: ToastAction;
	/** Sticky toasts skip the auto-dismiss timer — they stay until the user
	 *  dismisses them (or acts). For prompts that must not slip away. */
	sticky?: boolean;
};

type Listener = () => void;

let toasts: readonly Toast[] = [];
const listeners = new Set<Listener>();

function emit() {
	for (const fn of listeners) fn();
}

export function subscribe(onChange: Listener): () => void {
	listeners.add(onChange);
	return () => {
		listeners.delete(onChange);
	};
}

export function getSnapshot(): readonly Toast[] {
	return toasts;
}

export function pushToast(toast: Omit<Toast, "id">): string {
	const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
	const entry: Toast = { ...toast, id };
	toasts = [...toasts, entry];
	emit();
	if (!toast.sticky) {
		const ttl = toast.kind === ToastKind.Error ? 9000 : 4500;
		setTimeout(() => dismissToast(id), ttl);
	}
	return id;
}

export function dismissToast(id: string): void {
	const next = toasts.filter((t) => t.id !== id);
	if (next.length === toasts.length) return;
	toasts = next;
	emit();
}
