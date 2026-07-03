/**
 * Stage 10.3a — orchestrate the Y.Doc → encrypted-envelope → relay path,
 * and the reverse on receive.
 *
 * **Why the DEK only lives for one envelope.** The wire path always opens
 * the DEK from `EntityDekStore` on demand, uses it, and zeroes it in a
 * `finally`. There is no DEK cache. The cost is one master-key unwrap
 * per envelope; the gain is no plaintext DEK in memory across
 * unbounded time.
 *
 * **Per OQ-191 (resolved 2026-05-23)** every envelope carries a fresh
 * random 24-byte XChaCha nonce — extended-nonce XChaCha is safe under
 * CSPRNG with negligible birthday-bound collision probability for any
 * realistic vault size. No counter, no replay-window tracker at 10.3a;
 * 10.3b adds the per-(sender, entityId) seq tracker for replay-window
 * dup-drop.
 *
 * **Per OQ-193 (resolved 2026-05-23)** v1 emits one envelope per Y.Doc
 * `transact` boundary — the caller is expected to wrap the update flow
 * in `doc.transact(...)` so each commit is one logical change. The
 * pipeline itself just emits one envelope per `encryptAndEmit` call;
 * batching across transacts is a v2 concern.
 */

import { Buffer } from "node:buffer";
import { XCHACHA_NONCE_BYTES, bytesToBase64 } from "../credentials/crypto";
import type { MemberWrapPayload } from "../credentials/member-wraps";
import type { EntityDekStore } from "../entities/entity-dek-store";
import { type EncryptedFrame, decodeFrame, encodeFrame } from "./envelope-codec";
import {
	EntityIdMismatch,
	openAwarenessEnvelope,
	openUpdateEnvelope,
	openWrapBootstrapEnvelope,
	sealAwarenessEnvelope,
	sealUpdateEnvelope,
	sealWrapBootstrapEnvelope,
} from "./envelope-seal";
import type { RelayPort } from "./relay-port";
import { PROTOCOL_VERSION, type RoutingHeader, WireKind } from "./routing-header";

export type PipelineResolution = {
	id: string;
	type: string;
};

/** Stage 10.11 — the pipeline's view of the routing-token table (implemented
 *  by `RoutingTokenTable`; defined structurally here so the pipeline stays
 *  decoupled from the derivation module). */
export type RoutingTokenResolver = {
	/** The entity's CURRENT wire routing token, or null if none installed. */
	tokenFor(entityId: string): string | null;
	/** Does `routedId` route to `entityId` — current OR grace-window previous
	 *  generation? The receive-side header ↔ row binding in token mode. */
	isTokenFor(routedId: string, entityId: string): boolean;
};

export type PipelineContext = {
	dekStore: EntityDekStore;
	devicePub: Uint8Array;
	deviceSign: (bytes: Uint8Array) => Uint8Array;
	deviceVerify: (sig: Uint8Array, bytes: Uint8Array, senderPub: Uint8Array) => boolean;
	resolveEntity: (routedId: string) => PipelineResolution | null;
	/**
	 * Stage 10.11 — routing-token mode (OQ-197). When present the wire routes
	 * by a pseudonymous per-entity token instead of the raw entity id (see
	 * `routing-token.ts` for the position paper): emit puts `tokenFor(id)` in
	 * the header's `entityId` slot and FAILS CLOSED (`Unavailable`) when no
	 * token is installed — token mode never silently leaks a raw id; receive
	 * checks `isTokenFor(routedId, resolved.id)` so a frame routed under a
	 * token that is not the resolved entity's (current or grace-window
	 * previous) drops before any crypto. Absent ⇒ legacy raw-id routing
	 * (default, wire-compatible). When present, `resolveEntity` must resolve
	 * tokens back to entity rows (`RoutingTokenTable.resolve`).
	 */
	routingTokens?: RoutingTokenResolver;
	relay: RelayPort;
	/** Per-entity monotonic counter. 10.3a does not enforce replay-window
	 *  dedup (OQ-194 / 10.3b); the counter exists so 10.3b can wire the
	 *  tracker without a wire-format churn. */
	nextSeq: (entityId: string) => number;
	nowMs: () => number;
	/** Source of fresh 24-byte XChaCha nonces. Defaults to crypto random
	 *  via `node:crypto` randomBytes; injection is for deterministic tests. */
	randomNonce: () => Uint8Array;
	/**
	 * Stage 10.5c — revocation enforcement (OQ-203). Consulted BEFORE
	 * sig-verify / AEAD-open on every inbound envelope. `true` ⇒ the
	 * envelope drops with a `Revoked` named error; the cheap-fail path
	 * never even touches the crypto layer. Optional for forward
	 * compatibility with existing call sites; absent ⇒ revocation
	 * enforcement is off (back-compat default; production wires the
	 * predicate from `DevicesStore.isRevoked`).
	 */
	isDeviceRevoked?: (senderPub: Uint8Array) => boolean;
	/**
	 * Stage 10.7 — traffic-tick hooks for the sync-status surface. Fired
	 * AFTER a successful `relay.send(frame)` / `applyUpdate(...)` /
	 * `onAwarenessUpdate(...)` / `onWrapAccepted(...)`; **NOT** fired on
	 * throw paths so a dropped revoked / EntityIdMismatch / sig-fail
	 * envelope doesn't show up as inbound traffic. Default no-op so
	 * existing tests keep working without churn. The pipeline does not
	 * count drops via these callbacks — `droppedInbound` lives on the
	 * transport (`WebSocketRelayPort.droppedInbound()`), surfaced by
	 * `SyncStatusStore` separately.
	 */
	onSent?: (frameBytes: number) => void;
	onReceived?: (frameBytes: number) => void;
};

export type ApplyPlaintextFn = (plaintext: Uint8Array) => void | Promise<void>;

/**
 * Encrypt one Yjs update and emit it through the relay.
 *
 * The DEK is opened from the store and zeroed in `finally` whether or
 * not the seal/emit succeeds — no plaintext DEK leaks across the call.
 * `Unavailable` is thrown if the entity has no DEK row (a Stage 10.x
 * retro-wrap miss); the wire path must never silently skip rows.
 */
export async function encryptAndEmit(
	entityId: string,
	update: Uint8Array,
	ctx: PipelineContext,
): Promise<void> {
	await sealAndSend(entityId, update, WireKind.Update, ctx);
}

/**
 * Stage 10.14 — emit a full-state **`Snapshot`** envelope through the relay.
 *
 * Structurally identical to an `Update` envelope (same DEK-sealed payload +
 * signed routing header); only `kind` and the payload semantics differ — the
 * payload is the whole `Y.encodeStateAsUpdate(doc)`, not a delta. The durable
 * node (`brainstorm-sync` SYNC-2) treats a `Snapshot` frame as client-driven
 * compaction: it stores the blob as the new version and **resets the tail**, so
 * the client's local 256 KiB-tail compaction bounds the node's storage too.
 * Receivers apply it like any other frame (a full state merges idempotently).
 */
export async function emitSnapshot(
	entityId: string,
	fullState: Uint8Array,
	ctx: PipelineContext,
): Promise<void> {
	await sealAndSend(entityId, fullState, WireKind.Snapshot, ctx);
}

/** Shared seal-and-send for `Update` / `Snapshot` (one DEK lifetime, zeroed in
 *  `finally`). The two kinds share the envelope shape; only the discriminant +
 *  payload semantics differ. */
async function sealAndSend(
	entityId: string,
	payload: Uint8Array,
	kind: WireKind.Update | WireKind.Snapshot,
	ctx: PipelineContext,
): Promise<void> {
	const handle = ctx.dekStore.open(entityId);
	if (!handle) {
		throw named("Unavailable", `envelope-pipeline: no DEK for entity ${entityId}`);
	}
	try {
		const nonce = ctx.randomNonce();
		if (nonce.length !== XCHACHA_NONCE_BYTES) {
			throw named("Invalid", `envelope-pipeline: nonce must be ${XCHACHA_NONCE_BYTES} bytes`);
		}
		const header: RoutingHeader = {
			v: PROTOCOL_VERSION,
			kind,
			entityId: routedIdForEmit(entityId, ctx),
			sender: bytesToBase64Url(ctx.devicePub),
			seq: ctx.nextSeq(entityId),
			nonce: bytesToBase64(nonce),
			ts: ctx.nowMs(),
		};
		const frame = sealUpdateEnvelope({
			dek: handle.dek,
			header,
			payload,
			sign: ctx.deviceSign,
		});
		const wire = encodeFrame(frame);
		ctx.relay.send(wire);
		ctx.onSent?.(wire.byteLength);
	} finally {
		ctx.dekStore.close(handle.dek);
	}
}

/**
 * Decode an inbound frame, resolve the entity row, verify the signature
 * (against the sender pubkey carried in the header), open the AEAD with
 * AAD = re-canonicalised header bytes, then hand the plaintext Yjs
 * update to `applyUpdate`.
 *
 * Defense-in-depth:
 *   - `ctx.resolveEntity(frame.header.entityId)` returning null → throw
 *     `Unavailable`. A missing row at this point would otherwise be a
 *     silent drop.
 *   - The DEK is opened keyed by **the resolved row id**, not the
 *     header-supplied id (already validated equal by `openUpdateEnvelope`,
 *     but this is the load-bearing layer that closes the DEK-swap vector
 *     pinned by the 10.1 forward contract).
 *   - DEK zeroed in `finally`.
 */
export async function receiveAndApply(
	frame: Uint8Array,
	ctx: PipelineContext,
	applyUpdate: ApplyPlaintextFn,
): Promise<void> {
	const decoded = decodeFrame(frame);
	const resolved = ctx.resolveEntity(decoded.header.entityId);
	if (!resolved) {
		throw named("Unavailable", `envelope-pipeline: unknown entity ${decoded.header.entityId}`);
	}
	const senderPub = base64UrlToBytes(decoded.header.sender);
	// Stage 10.5c — OQ-203: revoke-check runs BEFORE sig-verify so a
	// revoked-device envelope drops on the cheap path. The verifier
	// retains the ability to open envelopes minted before `revokedAt`
	// only because envelopes minted AFTER `revokedAt` are dropped here;
	// existing DEKs are NOT re-wrapped (v1 deliberately limited per
	// OQ-203 — that's a `10.10`-style rotation operation).
	if (ctx.isDeviceRevoked?.(senderPub)) {
		throw named("Revoked", `envelope-pipeline: sender device is revoked (${decoded.header.sender})`);
	}
	const handle = ctx.dekStore.open(resolved.id);
	if (!handle) {
		throw named("Unavailable", `envelope-pipeline: no DEK for entity ${resolved.id}`);
	}
	try {
		const plaintext = openUpdateEnvelope({
			frame: decoded,
			dek: handle.dek,
			resolvedEntityId: resolved.id,
			verify: (sig, bytes) => ctx.deviceVerify(sig, bytes, senderPub),
			...routedBinding(decoded.header.entityId, resolved.id, ctx),
		});
		await applyUpdate(plaintext);
		ctx.onReceived?.(frame.byteLength);
	} finally {
		ctx.dekStore.close(handle.dek);
	}
}

/**
 * Stage 10.3b — emit a `WrapBootstrap` envelope through the relay.
 *
 * No DEK touch: the inner payload is `MemberWrapPayload` JSON which is
 * already HPKE-sealed for the recipient device. The pipeline orchestrates
 * the routing header (sender, seq, nonce, ts), seals via
 * `sealWrapBootstrapEnvelope`, and writes to the relay.
 *
 * The seq counter shares the pipeline's `nextSeq` source — receivers run
 * a per-(sender, entityId) tracker that treats wrap-bootstrap and update
 * frames in one continuous stream, so the producer must keep both
 * monotonic against the same counter.
 */
export async function emitWrapBootstrap(
	entityId: string,
	wrap: MemberWrapPayload,
	ctx: PipelineContext,
	/** Collab-C5 — an optional relay routing-key override. When set the frame is
	 *  fanned to subscribers of `route` (the recipient's inbox channel) rather
	 *  than `entityId`, so the wrap reaches a collaborator for an entity whose id
	 *  they don't yet know. `entityId` stays the AAD-bound real entity. */
	route?: string,
): Promise<void> {
	const nonce = ctx.randomNonce();
	if (nonce.length !== XCHACHA_NONCE_BYTES) {
		throw named("Invalid", `envelope-pipeline: nonce must be ${XCHACHA_NONCE_BYTES} bytes`);
	}
	const header: RoutingHeader = {
		v: PROTOCOL_VERSION,
		kind: WireKind.WrapBootstrap,
		entityId: routedIdForEmit(entityId, ctx),
		sender: bytesToBase64Url(ctx.devicePub),
		seq: ctx.nextSeq(entityId),
		nonce: bytesToBase64(nonce),
		ts: ctx.nowMs(),
		...(route ? { route } : {}),
	};
	const frame = sealWrapBootstrapEnvelope({ header, wrap, sign: ctx.deviceSign });
	const wire = encodeFrame(frame);
	ctx.relay.send(wire);
	ctx.onSent?.(wire.byteLength);
}

/**
 * Stage 10.3b — decode an inbound `WrapBootstrap` frame, resolve the
 * entity, verify the sender's signature, parse the wrap payload, and
 * hand it to `onWrapAccepted`.
 *
 * The callback shape mirrors `receiveAndApply`: the wire path itself
 * does NOT call `VaultSession.unwrapMemberWrap` — that lives in the
 * session because the X25519 secret never leaves it. The callback
 * receives the parsed wrap and the resolved entity id; the session-
 * aware orchestrator does the HPKE unseal and the install of the
 * decrypted DEK into `EntityDekStore`.
 */
export type WrapBootstrapAcceptedFn = (
	wrap: MemberWrapPayload,
	entityId: string,
) => void | Promise<void>;

export async function receiveWrapBootstrap(
	frame: Uint8Array,
	ctx: PipelineContext,
	onWrapAccepted: WrapBootstrapAcceptedFn,
): Promise<void> {
	const decoded = decodeFrame(frame);
	if (decoded.header.kind !== WireKind.WrapBootstrap) {
		throw named(
			"Invalid",
			`envelope-pipeline: receiveWrapBootstrap expected kind=${WireKind.WrapBootstrap}, got ${decoded.header.kind}`,
		);
	}
	const resolved = ctx.resolveEntity(decoded.header.entityId);
	if (!resolved) {
		throw named("Unavailable", `envelope-pipeline: unknown entity ${decoded.header.entityId}`);
	}
	const senderPub = base64UrlToBytes(decoded.header.sender);
	// Same OQ-203 contract as `receiveAndApply` — revoke-check before
	// sig-verify on the wrap-bootstrap path. A revoked device cannot
	// re-introduce its access by minting a fresh wrap-bootstrap.
	if (ctx.isDeviceRevoked?.(senderPub)) {
		throw named("Revoked", `envelope-pipeline: sender device is revoked (${decoded.header.sender})`);
	}
	const wrap = openWrapBootstrapEnvelope({
		frame: decoded,
		resolvedEntityId: resolved.id,
		verify: (sig, bytes) => ctx.deviceVerify(sig, bytes, senderPub),
		...routedBinding(decoded.header.entityId, resolved.id, ctx),
	});
	await onWrapAccepted(wrap, resolved.id);
	ctx.onReceived?.(frame.byteLength);
}

/**
 * Stage 10.6 — emit one awareness update through the relay.
 *
 * Same DEK lifetime as `encryptAndEmit`: open from `EntityDekStore`, seal,
 * send, zero in `finally`. The `seq` field carries `ctx.nextSeq(entityId)`
 * for **header debugging only** — the receive path deliberately does NOT
 * call `seqTracker.accept` for awareness (Yjs's awareness module already
 * does clock-based dedup keyed on `clientID`). Keeping the counter
 * monotonic lets the audit log + 10.7's sync-status panel show "awareness
 * frame seq=N" alongside `Update` frames without a parallel counter.
 */
export async function emitAwareness(
	entityId: string,
	awarenessUpdate: Uint8Array,
	ctx: PipelineContext,
): Promise<void> {
	const handle = ctx.dekStore.open(entityId);
	if (!handle) {
		throw named("Unavailable", `envelope-pipeline: no DEK for entity ${entityId}`);
	}
	try {
		const nonce = ctx.randomNonce();
		if (nonce.length !== XCHACHA_NONCE_BYTES) {
			throw named("Invalid", `envelope-pipeline: nonce must be ${XCHACHA_NONCE_BYTES} bytes`);
		}
		const header: RoutingHeader = {
			v: PROTOCOL_VERSION,
			kind: WireKind.Awareness,
			entityId: routedIdForEmit(entityId, ctx),
			sender: bytesToBase64Url(ctx.devicePub),
			seq: ctx.nextSeq(entityId),
			nonce: bytesToBase64(nonce),
			ts: ctx.nowMs(),
		};
		const frame = sealAwarenessEnvelope({
			dek: handle.dek,
			header,
			payload: awarenessUpdate,
			sign: ctx.deviceSign,
		});
		const wire = encodeFrame(frame);
		ctx.relay.send(wire);
		ctx.onSent?.(wire.byteLength);
	} finally {
		ctx.dekStore.close(handle.dek);
	}
}

/**
 * Stage 10.6 — decode + open an inbound `Awareness` frame and hand the
 * plaintext awareness-update bytes to `onAwarenessUpdate`.
 *
 * Same defense-in-depth contract as `receiveAndApply`:
 *   - Resolve the entity row → `Unavailable` if not found.
 *   - Revoked-sender drop **BEFORE** sig-verify (the 10.5c cheap path).
 *   - Open the DEK keyed by the **resolved row id**, not the header id.
 *   - DEK zeroed in `finally`.
 *
 * **No `seqTracker.accept` call.** y-protocols' `applyAwarenessUpdate` runs
 * its own per-`clientID` clock dedup — a duplicate awareness frame
 * decodes, opens, and is no-op'd downstream by the clock check. Routing
 * it through the seq-tracker would (a) eat the counter for a class of
 * frames it can't meaningfully reject and (b) tangle the awareness-frame
 * lifetime with the Yjs-update frame lifetime in a way 10.7's sync-status
 * surface would have to undo.
 */
export type AwarenessAcceptedFn = (
	awarenessUpdate: Uint8Array,
	entityId: string,
) => void | Promise<void>;

export async function receiveAwareness(
	frame: Uint8Array,
	ctx: PipelineContext,
	onAwarenessUpdate: AwarenessAcceptedFn,
): Promise<void> {
	const decoded = decodeFrame(frame);
	if (decoded.header.kind !== WireKind.Awareness) {
		throw named(
			"Invalid",
			`envelope-pipeline: receiveAwareness expected kind=${WireKind.Awareness}, got ${decoded.header.kind}`,
		);
	}
	const resolved = ctx.resolveEntity(decoded.header.entityId);
	if (!resolved) {
		throw named("Unavailable", `envelope-pipeline: unknown entity ${decoded.header.entityId}`);
	}
	const senderPub = base64UrlToBytes(decoded.header.sender);
	if (ctx.isDeviceRevoked?.(senderPub)) {
		throw named("Revoked", `envelope-pipeline: sender device is revoked (${decoded.header.sender})`);
	}
	const handle = ctx.dekStore.open(resolved.id);
	if (!handle) {
		throw named("Unavailable", `envelope-pipeline: no DEK for entity ${resolved.id}`);
	}
	try {
		const plaintext = openAwarenessEnvelope({
			frame: decoded,
			dek: handle.dek,
			resolvedEntityId: resolved.id,
			verify: (sig, bytes) => ctx.deviceVerify(sig, bytes, senderPub),
			...routedBinding(decoded.header.entityId, resolved.id, ctx),
		});
		await onAwarenessUpdate(plaintext, resolved.id);
		ctx.onReceived?.(frame.byteLength);
	} finally {
		ctx.dekStore.close(handle.dek);
	}
}

/** Re-export so callers don't have to import three modules for the bare
 *  primitives. The shape is the seal module's; the pipeline only orchestrates. */
export type { EncryptedFrame };

function named(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

/** Stage 10.11 — the wire routing id for an emit. Token mode FAILS CLOSED on a
 *  missing token (never silently leaks the raw entity id onto the wire). */
function routedIdForEmit(entityId: string, ctx: PipelineContext): string {
	if (!ctx.routingTokens) return entityId;
	const token = ctx.routingTokens.tokenFor(entityId);
	if (!token) {
		throw named("Unavailable", `envelope-pipeline: no routing token installed for ${entityId}`);
	}
	return token;
}

/** Stage 10.11 — receive-side header ↔ row binding in token mode: the routed
 *  token must be one the resolved entity actually routes under (current or
 *  grace-window previous). Legacy mode returns {} — the seal layer's raw-id
 *  equality check stays load-bearing there. */
function routedBinding(
	routedId: string,
	resolvedEntityId: string,
	ctx: PipelineContext,
): { expectedRoutingId?: string } {
	if (!ctx.routingTokens) return {};
	if (!ctx.routingTokens.isTokenFor(routedId, resolvedEntityId)) {
		throw new EntityIdMismatch(routedId, resolvedEntityId);
	}
	return { expectedRoutingId: routedId };
}

function bytesToBase64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

function base64UrlToBytes(encoded: string): Uint8Array {
	return new Uint8Array(Buffer.from(encoded, "base64url"));
}
