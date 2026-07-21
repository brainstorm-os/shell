/**
 * Drag-session state (DND-2, §Part IV.2). Pure holder of the
 * ONE active cross-app drag session — like `SelectionStore`, no IPC / Electron
 * here, so the lifecycle is trivially unit-tested; the `dnd` service handler
 * wraps it with capability gates, ghost painting, hit-testing, and broadcasts.
 *
 * Exactly one session is ever active (a second `begin` cancels the first). The
 * full `items` payload lives here, shell-side, and crosses to a target ONLY on
 * `drop` — never on hover (the privacy invariant, OQ-DND-2). `sourceApp` is the
 * broker-verified `envelope.app`, stamped at `begin`.
 */

import { DropEffect } from "@brainstorm-os/sdk-types";
import type { DragPayloadKind, ObjectDragItem, ObjectDragPayload } from "@brainstorm-os/sdk-types";

/** The current hover target, as resolved by hit-testing. */
export type DragTarget = {
	appId: string;
	windowId: string;
};

export type ActiveDragSession = {
	sessionId: string;
	sourceApp: string;
	payloadKind: DragPayloadKind;
	items: ObjectDragItem[];
	/** The window the cursor is currently over, or `null` (empty space). */
	target: DragTarget | null;
	/** The drop effect the current target last reported (the ghost affordance).
	 *  `None` until a target replies. */
	effect: DropEffect;
};

/** Shell-global, vault-independent holder of the single active drag session. */
export class DragSessionStore {
	private active: ActiveDragSession | null = null;
	private counter = 0;

	/** Open a new session, cancelling any in flight. Returns the new id. */
	begin(args: {
		sourceApp: string;
		payloadKind: DragPayloadKind;
		items: ObjectDragItem[];
	}): ActiveDragSession {
		this.counter += 1;
		this.active = {
			sessionId: `drag-${this.counter}`,
			sourceApp: args.sourceApp,
			payloadKind: args.payloadKind,
			items: args.items,
			target: null,
			effect: DropEffect.None,
		};
		return this.active;
	}

	/** The active session iff its id matches — guards against a stale `move`/
	 *  `drop`/`setEffect` from a session the shell already closed/replaced. */
	get(sessionId: string): ActiveDragSession | null {
		return this.active && this.active.sessionId === sessionId ? this.active : null;
	}

	getActive(): ActiveDragSession | null {
		return this.active;
	}

	/** Move the hover target. Returns `true` when the target CHANGED (so the
	 *  caller emits a fresh `app:drag-over` / clears the old one). Entering empty
	 *  space (`target: null`) resets the effect. */
	setTarget(sessionId: string, target: DragTarget | null): boolean {
		const s = this.get(sessionId);
		if (!s) return false;
		if (sameTarget(s.target, target)) return false;
		s.target = target;
		if (target === null) s.effect = DropEffect.None;
		return true;
	}

	/** Record the effect the current target reported (drives the ghost cursor). */
	setEffect(sessionId: string, effect: DropEffect): void {
		const s = this.get(sessionId);
		if (s) s.effect = effect;
	}

	/** Close the session (drop or cancel). Idempotent. */
	end(sessionId: string): void {
		if (this.active?.sessionId === sessionId) this.active = null;
	}

	/** Drop `app`'s session if it owns the active one (its window closed mid-drag). */
	endForApp(app: string): void {
		if (this.active?.sourceApp === app) this.active = null;
	}

	/** Build the reference-only wire payload for delivery on drop. */
	payloadOf(session: ActiveDragSession): ObjectDragPayload {
		return { v: 1, sourceApp: session.sourceApp, items: session.items };
	}
}

function sameTarget(a: DragTarget | null, b: DragTarget | null): boolean {
	if (a === null || b === null) return a === b;
	return a.appId === b.appId && a.windowId === b.windowId;
}
