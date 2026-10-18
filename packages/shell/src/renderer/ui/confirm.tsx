/**
 * Confirm dialog — imperative API via `confirm(params)` returning a
 * `Promise<boolean>`. Mount `<ConfirmHost />` once at the app root and any
 * call site can ask for confirmation without threading props.
 *
 * Built on the design-system primitives: `<Popover>` for chrome (header /
 * body / footer), `<Button>` for the cancel + confirm actions. Two
 * variants:
 *   - default action → `Primary`
 *   - destructive (delete / revoke / forget) → `Destructive`
 *
 * Usage:
 *   const ok = await confirm({
 *       title: "Delete wallpaper?",
 *       body: "This removes the image from this device. Cannot be undone.",
 *       confirmLabel: "Delete",
 *       confirmVariant: ConfirmVariant.Destructive,
 *   });
 *   if (ok) doIt();
 *
 * 6.15 — pass `kind` to name the prompt. A REVERSIBLE kind
 * (`canRememberConfirm`) adds a "Don't ask again" checkbox; once the user
 * confirms with it ticked, later `confirm()` calls of that kind resolve `true`
 * without a dialog until Settings → Interface → "Reset confirmations". An
 * irreversible kind never shows the checkbox, and main refuses to store one.
 */

import { type ConfirmKind, canRememberConfirm } from "@brainstorm-os/sdk-types";
import { AnimatePresence } from "framer-motion";
import { useState, useSyncExternalStore } from "react";
import { t } from "../i18n/t";
import { Button, ButtonVariant } from "./button";
import { Checkbox } from "./checkbox";
import { Popover } from "./popover";
import { PopoverBodyPadding, PopoverSize } from "./popover-types";

export enum ConfirmVariant {
	Primary = "primary",
	Destructive = "destructive",
}

export type ConfirmParams = {
	title: string;
	body?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	confirmVariant?: ConfirmVariant;
	/** Hide the cancel button (rare — defaults to false). */
	noCancel?: boolean;
	/** The prompt kind — see the module note. */
	kind?: ConfirmKind;
};

type ConfirmRequest = {
	id: string;
	params: ConfirmParams;
	resolve: (ok: boolean) => void;
};

type Listener = () => void;

let queue: readonly ConfirmRequest[] = [];
const listeners = new Set<Listener>();

function emit(): void {
	for (const fn of listeners) fn();
}

function subscribe(onChange: Listener): () => void {
	listeners.add(onChange);
	return () => {
		listeners.delete(onChange);
	};
}

function getSnapshot(): readonly ConfirmRequest[] {
	return queue;
}

export async function confirm(params: ConfirmParams): Promise<boolean> {
	if (canRememberConfirm(params.kind) && (await isRemembered(params.kind))) return true;
	return ask(params);
}

/** Read fresh on every ask: the choice is per vault, and Settings can reset it. */
async function isRemembered(kind: ConfirmKind): Promise<boolean> {
	try {
		const list = (await window.brainstorm?.confirmations?.list?.()) ?? [];
		return list.includes(kind);
	} catch {
		return false;
	}
}

function ask(params: ConfirmParams): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const id = `cf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
		queue = [...queue, { id, params, resolve }];
		emit();
	});
}

function respond(id: string, ok: boolean, remember = false): void {
	const target = queue.find((r) => r.id === id);
	if (!target) return;
	queue = queue.filter((r) => r.id !== id);
	emit();
	const { kind } = target.params;
	if (ok && remember && canRememberConfirm(kind)) {
		void window.brainstorm?.confirmations?.remember?.(kind)?.catch(() => false);
	}
	target.resolve(ok);
}

export function ConfirmHost() {
	const list = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
	const current = list[0];
	return (
		<AnimatePresence mode="wait">
			{current && <ConfirmDialog key={current.id} request={current} />}
		</AnimatePresence>
	);
}

function ConfirmDialog({ request }: { request: ConfirmRequest }) {
	const {
		title,
		body,
		confirmLabel,
		cancelLabel,
		confirmVariant = ConfirmVariant.Primary,
		noCancel = false,
		kind,
	} = request.params;
	const rememberable = canRememberConfirm(kind);
	const [remember, setRemember] = useState(false);
	const onConfirm = () => respond(request.id, true, remember);
	const onCancel = () => respond(request.id, false);
	const buttonVariant =
		confirmVariant === ConfirmVariant.Destructive ? ButtonVariant.Destructive : ButtonVariant.Primary;
	return (
		<Popover
			title={title}
			onClose={onCancel}
			size={PopoverSize.Small}
			bodyPadding={PopoverBodyPadding.Comfortable}
			fitContent
			testId="confirm-dialog"
			footer={
				<>
					{!noCancel && (
						<Button variant={ButtonVariant.Neutral} onClick={onCancel}>
							{cancelLabel ?? t("shell.actions.cancel")}
						</Button>
					)}
					<Button variant={buttonVariant} onClick={onConfirm}>
						{confirmLabel ?? t("shell.actions.confirm")}
					</Button>
				</>
			}
		>
			{body && <p className="confirm__body">{body}</p>}
			{rememberable && (
				<div className="confirm__remember">
					<Checkbox
						checked={remember}
						onChange={setRemember}
						label={t("shell.confirm.dontAskAgain")}
						data-testid="confirm-dont-ask-again"
					/>
				</div>
			)}
		</Popover>
	);
}
