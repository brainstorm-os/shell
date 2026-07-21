/**
 * `selection` broker service (DND-1, §Part IV.1).
 *
 * The host service 17-interoperability.md
 * specified but never built: the shell holds the **focused app's** published
 * selection in a single in-memory slot, so selection-driven intents, the action
 * surface, and the keyboard "move to…" path can answer "what does the user have
 * selected" without each app reinventing it. It is also the cross-app drag
 * payload at rest — DND-2+ carry this slot in motion.
 *
 * Privacy by construction: ONE slot, stamped with the publishing app's verified
 * identity and CLEARED the moment focus leaves that app. There is no cross-app
 * aggregation and no way for app B to read app A's selection while A is not
 * focused. `selection.read` is additionally a scarce capability (granted to the
 * shell's privileged consumers, not default-minimum for apps).
 *
 * SECURITY: `envelope.app` is already verified against the renderer-identity
 * registry by the broker before dispatch, so it is a trustworthy `sourceApp`.
 * The generic declared-caps check is necessary-but-not-sufficient (the app
 * controls `envelope.caps`), so both caps are RE-CHECKED against the active
 * vault's ledger here. Fail-closed: ledger error / no vault → `Unavailable`;
 * cap not held → `Denied`.
 */

import type { ObjectDragItem, SelectionSnapshot } from "@brainstorm-os/sdk-types";
import { hardenObjectDragItems } from "@brainstorm-os/sdk/entity-drag";
import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import { type CapabilityLedger, LedgerUnavailableError } from "../capabilities/ledger";

/** Lets an app publish its own selection. Broadly grantable (opt-in per
 *  manifest) — an app publishing its own selection is low-risk. */
export const SELECTION_PUBLISH_CAPABILITY = "selection.publish";
/** Lets a consumer READ the focused app's selection. Scarce (privileged shell
 *  consumers — action surface, agent — not default-minimum for apps), because
 *  it crosses the app boundary: it reveals another app's current selection. */
export const SELECTION_READ_CAPABILITY = "selection.read";

export enum SelectionMethod {
	Publish = "publish",
	Current = "current",
}

/**
 * Shell-global, vault-independent holder of the focused app's selection. One
 * slot; replaced on `publish`, cleared on focus change or window close. Pure
 * over its inputs (no IPC / ledger) so it is trivially unit-testable; the
 * handler wraps it with the capability gate.
 */
export class SelectionStore {
	private slot: SelectionSnapshot | null = null;

	/** Replace `app`'s selection. An empty (or all-malformed) item set clears
	 *  the slot iff `app` currently owns it (a deselect) — it never clobbers
	 *  another app's slot. */
	publish(app: string, items: unknown): void {
		const hardened = hardenObjectDragItems(items);
		if (hardened.length === 0) {
			if (this.slot?.sourceApp === app) this.slot = null;
			return;
		}
		this.slot = { sourceApp: app, items: hardened };
	}

	/** The current slot, or `null`. */
	current(): SelectionSnapshot | null {
		return this.slot;
	}

	/** Clear the slot when focus moves to an app that does not own it (or to no
	 *  app). Wired to the window-index focus-change signal. */
	clearForFocus(focusedApp: string | null): void {
		if (this.slot && this.slot.sourceApp !== focusedApp) this.slot = null;
	}

	/** Drop `app`'s selection (e.g. its last window closed). */
	clearApp(app: string): void {
		if (this.slot?.sourceApp === app) this.slot = null;
	}
}

export type SelectionServiceOptions = {
	readonly store: SelectionStore;
	/** SECURITY — the active vault's capability ledger, to re-check the
	 *  `selection.*` grants server-side. Absent → the gate is skipped (unit
	 *  tests that presume authorization). */
	readonly getLedger?: () => Promise<CapabilityLedger | null>;
	/** The currently-focused app id (from the window index), or `null`. Read on
	 *  every `current()` so the slot is validated against LIVE focus and
	 *  self-clears if it is no longer the focused app's — race-free, no
	 *  focus-event wiring. Absent → no focus check (the slot is always returned;
	 *  unit tests / non-windowed hosts). */
	readonly getFocusedApp?: () => string | null;
};

function makeError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

async function assertCapability(
	options: SelectionServiceOptions,
	envelope: Envelope,
	capability: string,
): Promise<void> {
	if (!options.getLedger) return;
	let ledger: CapabilityLedger | null;
	try {
		ledger = await options.getLedger();
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "selection: capability ledger unavailable");
		}
		throw error;
	}
	if (!ledger) throw makeError("Unavailable", "selection: no active vault session");
	let held: boolean;
	try {
		held = ledger.has(envelope.app, capability);
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "selection: capability ledger unavailable");
		}
		throw error;
	}
	if (!held) throw makeError("Denied", `selection: ${envelope.app} lacks ${capability}`);
}

export function makeSelectionServiceHandler(options: SelectionServiceOptions): ServiceHandler {
	return async (envelope: Envelope): Promise<unknown> => {
		switch (envelope.method) {
			case SelectionMethod.Publish: {
				await assertCapability(options, envelope, SELECTION_PUBLISH_CAPABILITY);
				const [items] = envelope.args as [unknown];
				options.store.publish(envelope.app, items);
				return undefined;
			}
			case SelectionMethod.Current: {
				await assertCapability(options, envelope, SELECTION_READ_CAPABILITY);
				if (options.getFocusedApp) options.store.clearForFocus(options.getFocusedApp());
				return options.store.current();
			}
			default:
				throw makeError("Invalid", `unknown selection method: ${envelope.method}`);
		}
	};
}

/** Re-export for callers that read the slot directly (the action surface, the
 *  drag-session begin in DND-2). */
export type { ObjectDragItem, SelectionSnapshot };
