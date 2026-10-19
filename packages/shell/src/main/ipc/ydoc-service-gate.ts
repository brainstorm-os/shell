/**
 * SH-ydoc-gate — the broker-registered `ydoc` service is main-process-only.
 *
 * Its handlers authorise nothing (the entities / history / sharing services do
 * that before calling it) and take `vaultPath` per call, so an app reaching it
 * directly would read and write any entity's document and write outside the
 * vault. Only the main process acts as `SHELL_MAIN_APP_ID`, which no manifest
 * or renderer may claim, so the gate refuses every other caller. Even for the
 * shell, the vault is the ACTIVE session's: a mismatching `vaultPath` is
 * refused rather than followed or silently rewritten onto another vault.
 */

import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import { SHELL_MAIN_APP_ID } from "../apps/manifest";

function named(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

export function gateYDocService(
	inner: ServiceHandler,
	getActiveVaultPath: () => string | null,
): ServiceHandler {
	return (envelope: Envelope, source?: unknown) => {
		if (envelope.app !== SHELL_MAIN_APP_ID) {
			return Promise.reject(named("Denied", `ydoc.${envelope.method} is shell-internal`));
		}
		const vaultPath = getActiveVaultPath();
		if (!vaultPath) return Promise.reject(named("Unavailable", "ydoc: no active vault"));
		const args: unknown[] = [];
		for (const a of envelope.args) {
			if (!a || typeof a !== "object" || Array.isArray(a)) {
				args.push(a);
				continue;
			}
			const supplied = (a as { vaultPath?: unknown }).vaultPath;
			if (supplied !== undefined && supplied !== vaultPath) {
				return Promise.reject(named("Denied", `ydoc.${envelope.method}: not the active vault`));
			}
			args.push({ ...a, vaultPath });
		}
		return Promise.resolve(inner({ ...envelope, args }, source));
	};
}
