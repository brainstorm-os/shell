/**
 * Collab-C4-live — the dev-only bridge that drives the C1/C2 share flow over
 * the LIVE relay against the PERSISTED `YDocStore`, so two real shells (two
 * different *users*) can dogfood collaboration through the shipped app.
 *
 * The owner-side share/revoke/createInvite core now lives in the reusable
 * {@link SharingEngine} (shared with the production `sharing` broker service);
 * this bridge is the thin dev/dogfood wrapper that layers a bespoke inbound
 * RECEIVER on top — in production that receiver is the always-on
 * `LiveSyncEngine` (10.12), so the bridge's receiver is test-support only. The
 * class is the testable core; the `dev:collab:*` IPC handlers
 * (`ipc/collab-dev-handlers.ts`) are thin wrappers that bind one instance to
 * the active vault session + relay, registered behind the same dev env-gate as
 * the soak handlers — never shipped in a packaged build.
 *
 * **Why a combined, serialized receiver.** The owner emits the member-wrap
 * (`WrapBootstrap`) and then the encrypted doc-state (`Update`) over the same
 * relay. The collaborator MUST install the DEK from the wrap before it can
 * decrypt the state, so the receiver processes frames strictly in arrival
 * order through one promise chain.
 */

import * as Y from "yjs";
import { decodeFrame } from "../sync/envelope-codec";
import { receiveAndApply, receiveWrapBootstrap } from "../sync/envelope-pipeline";
import { WireKind } from "../sync/routing-header";
import type { VaultSession } from "../vault/session";
import { type AccessRole, isAccessRole } from "./access-record";
import type { ShareInvite } from "./share-invite";
import {
	type CollabAccessView,
	type CollabIdentity,
	type CollabRelayLike,
	SharingEngine,
} from "./sharing-engine";

export type { CollabAccessView, CollabIdentity, CollabRelayLike } from "./sharing-engine";

/** Yjs text type the dogfood co-edit writes into. The real editor uses its own
 *  Lexical-bound types; this is a plain scratch surface for the harness so a
 *  collab session can prove convergence without booting the full editor. */
const COLLAB_TEXT_KEY = "collab-text";

export class CollabDevBridge {
	readonly #session: VaultSession;
	readonly #getRelay: () => CollabRelayLike | null;
	readonly #engine: SharingEngine;
	#receiver: ((frame: Uint8Array) => void) | null = null;
	/** Every entity channel this shell currently subscribes to. The receiver is a
	 *  single shared listener that dispatches each frame by its own header
	 *  entityId, so one teammate can hold live subscriptions to many shared docs
	 *  at once (mirrors the production LiveSyncEngine; fixes the single-entity
	 *  receiver, F-289). */
	readonly #receiverEntityIds = new Set<string>();
	#receiveChain: Promise<unknown> = Promise.resolve();

	constructor(session: VaultSession, getRelay: () => CollabRelayLike | null) {
		this.#session = session;
		this.#getRelay = getRelay;
		this.#engine = new SharingEngine(session, getRelay);
	}

	/** This shell's sovereign identity + wrapping key. */
	whoami(): CollabIdentity {
		return this.#engine.whoami();
	}

	/** Collaborator-side: mint a self-signed `ShareInvite`. */
	createInvite(label: string): ShareInvite {
		return this.#engine.createInvite(label);
	}

	/** Owner-side: create the entity row + DEK + the owner's Owner grant.
	 *  `properties` seeds the row (e.g. a message's `conversation`). */
	async provisionEntity(
		entityId: string,
		type: string,
		properties?: Record<string, unknown>,
	): Promise<void> {
		await this.#engine.provisionEntity(entityId, type, properties ?? { name: entityId });
	}

	/**
	 * Subscribe to `entityId`'s relay channel and install the combined,
	 * serialized receiver (WrapBootstrap → install DEK, Update → apply). Usable
	 * by BOTH sides. Idempotent + ADDITIVE — a second call subscribes another
	 * channel without dropping the first, so a teammate can hold many shared docs
	 * live at once. Ensures a local entity row exists (no DEK yet on the
	 * collaborator side — the wrap installs it). This bespoke receiver is the
	 * dev/dogfood analog of the production `LiveSyncEngine`.
	 */
	async installShareReceiver(entityId: string, type: string): Promise<void> {
		await this.#engine.ensureDekStore();
		const repo = await this.#engine.ensureEntitiesRepo();
		this.#engine.recordType(entityId, type);
		if (!repo.get(entityId)) {
			repo.create({
				id: entityId,
				type,
				properties: { name: entityId },
				createdBy: `${this.#session.identity.publicKeyBase64} (received)`,
				now: Date.now(),
				dekId: null,
			});
		}
		const relay = this.#engine.requireRelay();
		relay.subscribe?.(entityId);
		this.#receiverEntityIds.add(entityId);
		// One shared listener for ALL subscribed channels; it dispatches each frame
		// by the entityId in the frame's own header (#handleFrame). Installing a
		// second entity must not drop the first.
		if (!this.#receiver) {
			const listener = (frame: Uint8Array): void => {
				this.#receiveChain = this.#receiveChain.catch(() => {}).then(() => this.#handleFrame(frame));
			};
			relay.onFrame(listener);
			this.#receiver = listener;
		}
	}

	/** Owner-side share — delegates to the engine. */
	async share(opts: {
		entityId: string;
		type: string;
		invite: ShareInvite;
		role: AccessRole;
	}): Promise<CollabAccessView[]> {
		return this.#engine.share(opts);
	}

	/** Owner-side collection share — share the container + cascade onto its
	 *  existing children (design 71). Delegates to the engine. */
	async shareCollection(opts: {
		entityId: string;
		type: string;
		invite: ShareInvite;
		role: AccessRole;
	}): Promise<CollabAccessView[]> {
		return this.#engine.shareCollection(opts);
	}

	/** Append text into the doc's scratch text type and emit the delta. */
	async editText(entityId: string, text: string): Promise<void> {
		await this.#engine.mutateAndEmit(entityId, (doc) => {
			const t = doc.getText(COLLAB_TEXT_KEY);
			t.insert(t.length, text);
		});
	}

	/** Owner revokes `memberB64` (signed, append-only audit) and emits the delta. */
	async revoke(entityId: string, memberB64: string): Promise<boolean> {
		return this.#engine.revoke(entityId, memberB64);
	}

	/** The resolved access log (active + revoked audit) for `entityId`. */
	async access(entityId: string): Promise<CollabAccessView[]> {
		return this.#engine.access(entityId);
	}

	/** The persisted doc's state vector — equal across peers ⇒ converged. */
	async stateVector(entityId: string): Promise<Uint8Array> {
		const { doc } = await this.#session.ydocStore.load(entityId);
		try {
			return Y.encodeStateVector(doc);
		} finally {
			doc.destroy();
		}
	}

	/** The current scratch text — a cheap content-level convergence check. */
	async readText(entityId: string): Promise<string> {
		const { doc } = await this.#session.ydocStore.load(entityId);
		try {
			return doc.getText(COLLAB_TEXT_KEY).toString();
		} finally {
			doc.destroy();
		}
	}

	dispose(): void {
		const relay = this.#getRelay();
		if (relay) this.#detachReceiver(relay);
	}

	// --- internals ----------------------------------------------------------

	async #handleFrame(frame: Uint8Array): Promise<void> {
		try {
			const decoded = decodeFrame(frame);
			const entityId = decoded.header.entityId;
			if (!this.#receiverEntityIds.has(entityId)) return;
			const relay = this.#getRelay();
			if (!relay) return;
			const ctx = this.#engine.makeCtx(relay.currentPort());
			if (decoded.header.kind === WireKind.WrapBootstrap) {
				await receiveWrapBootstrap(frame, ctx, async (received, id) => {
					await this.#engine.installWrap(received, id);
				});
			} else if (decoded.header.kind === WireKind.Update) {
				await receiveAndApply(frame, ctx, async (plaintext) => {
					await this.#engine.serializedAppendUpdate(entityId, plaintext);
				});
			}
		} catch (error) {
			console.warn(`[dev:collab] receive failed: ${(error as Error).message}`);
		}
	}

	#detachReceiver(relay: CollabRelayLike): void {
		if (this.#receiver) {
			relay.offFrame(this.#receiver);
			this.#receiver = null;
		}
		for (const id of this.#receiverEntityIds) relay.unsubscribe?.(id);
		this.#receiverEntityIds.clear();
	}
}

/** Parse + validate an `AccessRole` from the wire (IPC string arg). */
export function parseAccessRole(value: unknown): AccessRole {
	if (isAccessRole(value)) return value;
	throw new Error(`collab-dev-bridge: invalid role "${String(value)}"`);
}
