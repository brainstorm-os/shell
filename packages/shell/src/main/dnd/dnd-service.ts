/**
 * `dnd` broker service (DND-2, §Part IV.2) — the shell-mediated
 * cross-app drag session. Native HTML5 DnD can't cross the per-app renderer
 * boundary (a `DataTransfer` doesn't serialize across processes), so the shell
 * runs the drag: stamps `sourceApp`, owns the cursor-following ghost overlay,
 * hit-tests the target window via the window index, negotiates the drop
 * (kinds+point on hover, payload only on drop), and re-checks caps fail-closed.
 *
 * The pure session lifecycle lives in `DragSessionStore`; hit-testing in
 * `hitTestWindow`; this handler is the orchestration that wires them to the
 * capability ledger + the (injected) ghost overlay + the (injected) per-window
 * notifier. The Electron-specific bindings — the real transparent click-through
 * ghost `BrowserWindow` (OQ-DND-1 → option (a)) and the renderer pointer
 * forwarding — are DND-2b; this layer is fully unit-testable through the seams.
 *
 * PRIVACY (OQ-DND-2): `app:drag-over` carries kinds + within-window point ONLY;
 * the full payload + `sourceApp` reach a target ONLY via `app:drop`. SECURITY:
 * `dnd.drag` (start) and `dnd.drop` (receive) are re-checked against the live
 * ledger here — the broker's declared-caps check is app-controlled; the actual
 * mutation is gated again by the target's own op cap at perform time. Fail-
 * closed: ledger error / no vault → `Unavailable`; cap not held → `Denied` (for
 * the caller) or a silently-skipped delivery (for a target lacking `dnd.drop`).
 */

import { type CapabilityLedger, LedgerUnavailableError } from "@brainstorm-os/capabilities/ledger";
import type { WindowEntry } from "@brainstorm-os/protocol/window-types";
import {
	APP_DRAG_LEAVE_CHANNEL,
	APP_DRAG_OVER_CHANNEL,
	APP_DROP_CHANNEL,
	DropEffect,
} from "@brainstorm-os/sdk-types";
import type {
	DragGhostSpec,
	DragOverNotice,
	DragPayloadKind,
	DragPoint,
	DragSessionInfo,
	DropDelivery,
	DropResult,
} from "@brainstorm-os/sdk-types";
import { hardenObjectDragItems, objectDragItemTypes } from "@brainstorm-os/sdk/entity-drag";
import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import type { ActiveDragSession, DragSessionStore, DragTarget } from "./drag-session";
import { hitTestWindow } from "./hit-test";

/** Start a drag — start your OWN drag of your OWN selection. Default-minimum. */
export const DND_DRAG_CAPABILITY = "dnd.drag";
/** Receive a cross-app drop payload. Default-minimum (participation); the real
 *  authorization is the per-operation cap the target re-checks at perform. */
export const DND_DROP_CAPABILITY = "dnd.drop";
/** Drag a file OUT of Brainstorm to the OS (scope D). The app exports its OWN
 *  content (bytes it already holds) to a temp path the OS drag reads.
 *  Lowercase/kebab — a camelCase capability string fails the envelope's
 *  `CAPABILITY_PATTERN`, so the broker would reject the stamped `caps` hint with
 *  `Invalid` before the grant check (the `export.printToPdf` failure mode). */
export const DND_EXPORT_CAPABILITY = "dnd.export-file";
/** Upper bound on a single `exportFile` payload — bounds IPC + disk abuse from a
 *  default-granted app (a huge buffer or a spam of them). 256 MiB covers any
 *  realistic single file; larger exports are refused (no OS drag started). */
export const DND_EXPORT_MAX_BYTES = 256 * 1024 * 1024;

/** Shell→target push channels (single home: `@brainstorm-os/sdk-types`, shared
 *  with the app-preload forwarder). Re-exported for the existing tests. */
export { APP_DRAG_LEAVE_CHANNEL, APP_DRAG_OVER_CHANNEL, APP_DROP_CHANNEL };

export enum DndMethod {
	Begin = "begin",
	Move = "move",
	Drop = "drop",
	Cancel = "cancel",
	SetEffect = "setEffect",
	ExportFile = "exportFile",
}

/** Materialise an app's file bytes to a temp path and hand the OS drag to that
 *  app's window via `webContents.startDrag` (DND-5, scope D). Injected — the
 *  Electron binding (temp write + window resolve + startDrag + drag icon) lives
 *  in `index.ts`; absent in unit tests. Returns whether the OS drag started. */
export type FileExporter = (
	app: string,
	file: { name: string; bytes: Uint8Array },
) => Promise<boolean>;

/** The shell-owned cursor-following ghost overlay (OQ-DND-1 → a transparent
 *  click-through always-on-top window). Injected so the session is unit-tested
 *  without a real `BrowserWindow`; the real binding is DND-2b. */
export type GhostOverlay = {
	show(spec: DragGhostSpec, at: DragPoint): void;
	move(to: DragPoint): void;
	setEffect(effect: DropEffect): void;
	hide(): void;
};

/** Deliver a push message to one app window. Injected — the real impl finds the
 *  window via the launcher (`{appId, windowId}` since windowId isn't globally
 *  unique across apps) and `webContents.send`s. */
export type WindowNotifier = (target: DragTarget, channel: string, payload: unknown) => void;

export type DndServiceOptions = {
	readonly store: DragSessionStore;
	readonly ghost: GhostOverlay;
	readonly notify: WindowNotifier;
	/** Most-recently-focused-first window snapshot for hit-testing. */
	readonly windowEntries: () => readonly WindowEntry[];
	/** SECURITY — the active vault's ledger for the server-side cap re-check.
	 *  Absent → gate skipped (unit tests). */
	readonly getLedger?: () => Promise<CapabilityLedger | null>;
	/** Drag-a-file-out binding (DND-5). Absent → `exportFile` reports not-started. */
	readonly exportFile?: FileExporter;
};

function makeError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

async function resolveLedger(options: DndServiceOptions): Promise<CapabilityLedger | undefined> {
	if (!options.getLedger) return undefined; // gate skipped
	try {
		const ledger = await options.getLedger();
		if (!ledger) throw makeError("Unavailable", "dnd: no active vault session");
		return ledger;
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "dnd: capability ledger unavailable");
		}
		throw error;
	}
}

async function assertCap(
	options: DndServiceOptions,
	envelope: Envelope,
	capability: string,
): Promise<void> {
	const ledger = await resolveLedger(options);
	if (ledger === undefined) return; // no getLedger wired
	let held: boolean;
	try {
		held = ledger.has(envelope.app, capability);
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "dnd: capability ledger unavailable");
		}
		throw error;
	}
	if (!held) throw makeError("Denied", `dnd: ${envelope.app} lacks ${capability}`);
}

function overNotice(session: ActiveDragSession, hit: { pointInWindow: DragPoint }): DragOverNotice {
	return {
		sessionId: session.sessionId,
		payloadKind: session.payloadKind,
		// Deduped entity-type URLs — the only item info a hover leaks (shared with
		// the SDK drop target so the leak set and the read can't diverge).
		itemTypes: objectDragItemTypes(session.items),
		pointInWindow: hit.pointInWindow,
	};
}

/** Hit-test, update the session's target, and emit drag-over/leave on change. */
function trackTo(options: DndServiceOptions, session: ActiveDragSession, point: DragPoint): void {
	const hit = hitTestWindow(options.windowEntries(), point);
	const prev = session.target;
	const next: DragTarget | null = hit ? { appId: hit.appId, windowId: hit.windowId } : null;
	const changed = options.store.setTarget(session.sessionId, next);
	if (!changed) {
		// Same target — still refresh the within-window point so the target can
		// track the cursor (cheap; no leave/over churn).
		if (hit && next) options.notify(next, APP_DRAG_OVER_CHANNEL, overNotice(session, hit));
		return;
	}
	if (prev) options.notify(prev, APP_DRAG_LEAVE_CHANNEL, { sessionId: session.sessionId });
	if (hit && next) options.notify(next, APP_DRAG_OVER_CHANNEL, overNotice(session, hit));
}

export function makeDndServiceHandler(options: DndServiceOptions): ServiceHandler {
	const { store, ghost } = options;
	return async (envelope: Envelope): Promise<unknown> => {
		switch (envelope.method) {
			case DndMethod.Begin: {
				await assertCap(options, envelope, DND_DRAG_CAPABILITY);
				const [args] = envelope.args as [
					{
						payloadKind: DragPayloadKind;
						items: unknown;
						ghost: DragGhostSpec;
						screenPoint: DragPoint;
					},
				];
				const items = hardenObjectDragItems(args.items);
				const session = store.begin({
					sourceApp: envelope.app,
					payloadKind: args.payloadKind,
					items,
				});
				ghost.show(args.ghost, args.screenPoint);
				trackTo(options, session, args.screenPoint);
				const info: DragSessionInfo = {
					sessionId: session.sessionId,
					payloadKind: session.payloadKind,
					itemCount: items.length,
				};
				return info;
			}
			case DndMethod.Move: {
				await assertCap(options, envelope, DND_DRAG_CAPABILITY);
				const [args] = envelope.args as [{ sessionId: string; screenPoint: DragPoint }];
				const session = store.get(args.sessionId);
				// Only the source may drive its own session.
				if (!session || session.sourceApp !== envelope.app) return undefined;
				ghost.move(args.screenPoint);
				trackTo(options, session, args.screenPoint);
				return undefined;
			}
			case DndMethod.SetEffect: {
				await assertCap(options, envelope, DND_DROP_CAPABILITY);
				const [args] = envelope.args as [{ sessionId: string; effect: DropEffect }];
				const session = store.get(args.sessionId);
				// Only the CURRENT target app may set the effect.
				if (!session || session.target?.appId !== envelope.app) return undefined;
				store.setEffect(args.sessionId, args.effect);
				ghost.setEffect(args.effect);
				return undefined;
			}
			case DndMethod.Drop: {
				await assertCap(options, envelope, DND_DRAG_CAPABILITY);
				const [args] = envelope.args as [{ sessionId: string; screenPoint: DragPoint }];
				const session = store.get(args.sessionId);
				if (!session || session.sourceApp !== envelope.app) {
					return { delivered: false, effect: DropEffect.None, targetApp: null } satisfies DropResult;
				}
				const hit = hitTestWindow(options.windowEntries(), args.screenPoint);
				const result = await deliverDrop(options, session, hit, args.screenPoint);
				ghost.hide();
				store.end(session.sessionId);
				return result;
			}
			case DndMethod.Cancel: {
				await assertCap(options, envelope, DND_DRAG_CAPABILITY);
				const [args] = envelope.args as [{ sessionId: string }];
				const session = store.get(args.sessionId);
				if (session && session.sourceApp === envelope.app) {
					if (session.target) {
						options.notify(session.target, APP_DRAG_LEAVE_CHANNEL, {
							sessionId: session.sessionId,
						});
					}
					ghost.hide();
					store.end(session.sessionId);
				}
				return undefined;
			}
			case DndMethod.ExportFile: {
				await assertCap(options, envelope, DND_EXPORT_CAPABILITY);
				const [args] = envelope.args as [{ name: unknown; bytes: unknown }];
				const name = typeof args?.name === "string" ? args.name : "";
				const bytes = args?.bytes;
				if (
					!options.exportFile ||
					!(bytes instanceof Uint8Array) ||
					bytes.length === 0 ||
					bytes.length > DND_EXPORT_MAX_BYTES
				) {
					return { started: false };
				}
				const started = await options.exportFile(envelope.app, { name, bytes });
				return { started };
			}
			default:
				throw makeError("Invalid", `unknown dnd method: ${envelope.method}`);
		}
	};
}

async function deliverDrop(
	options: DndServiceOptions,
	session: ActiveDragSession,
	hit: { appId: string; windowId: string; pointInWindow: DragPoint } | null,
	_screenPoint: DragPoint,
): Promise<DropResult> {
	if (!hit) return { delivered: false, effect: DropEffect.None, targetApp: null };
	// Re-check the TARGET holds dnd.drop against the live ledger (fail-closed:
	// a target lacking the cap silently never receives the payload).
	const ledger = await resolveLedger(options);
	if (ledger !== undefined) {
		let held = false;
		try {
			held = ledger.has(hit.appId, DND_DROP_CAPABILITY);
		} catch {
			held = false;
		}
		if (!held) return { delivered: false, effect: DropEffect.None, targetApp: null };
	}
	const delivery: DropDelivery = {
		sessionId: session.sessionId,
		payloadKind: session.payloadKind,
		payload: options.store.payloadOf(session),
		pointInWindow: hit.pointInWindow,
		effect: session.effect,
	};
	options.notify({ appId: hit.appId, windowId: hit.windowId }, APP_DROP_CHANNEL, delivery);
	return { delivered: true, effect: session.effect, targetApp: hit.appId };
}
