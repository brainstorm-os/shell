/**
 * Stage 10.4 — minimal wire decoder duplicated into the relay-server.
 *
 * The relay deliberately depends on **nothing** from `@brainstorm-os/shell`.
 * It must be deployable as its own process (and eventually as a tiny
 * standalone binary) without dragging in any shell modules. The wire
 * format is the structural surface — `routing-header.ts` /
 * `envelope-codec.ts` in the shell are the canonical source; this file
 * mirrors only the parts the relay needs to peek at (the routing header)
 * and the strict shape validator that pins the header schema.
 *
 * Relay-blind invariant: this module must not import any noble package,
 * any envelope-seal / envelope-crypto sibling, or anything credential-
 * shaped. The 12th structural CI fence in
 * `tools/mcp-server/src/tools/relay-noble-import-check.ts` covers files
 * under `packages/relay-server/src/` AND any file named under
 * `sync/` — keeping the relay decoder free of crypto is what lets the
 * relay-server stay structurally blind to envelope contents.
 *
 * Wire layout (matches the shell's `envelope-codec.ts`):
 *
 *   u32-be(headerLen) || canonicalHeaderBytes
 *     || u16-be(sigLen=64) || sig
 *     || u32-be(ctLen) || ciphertext
 *
 * The relay reads `headerLen` + the canonical header bytes; it parses the
 * header (entity-id + sender-pubkey for the audit log + kind for routing)
 * and forwards the entire untouched frame to subscribers. The ciphertext
 * after the header is opaque — the relay never decodes it.
 */

// relay-blind: this file intentionally has zero crypto/credential imports.
// The CI gate at tools/mcp-server/src/tools/relay-noble-import-check.ts
// asserts this; the imports below are forbidden and any future addition
// requires a per-line `// relay-blind-exempt` review note.

export const PROTOCOL_VERSION = 1 as const;
export const ED25519_SIG_BYTES = 64;

export enum WireKind {
	Update = "update",
	Snapshot = "snapshot",
	WrapBootstrap = "wrap-bootstrap",
	/** Stage 10.5c — pairing handshake transport (routed by `pairingChannelId`
	 *  as the `entityId`). The relay never inspects the body — same as
	 *  every other kind. */
	Pairing = "pairing",
	/** Stage 10.6 — transient awareness updates (cursor / presence). Body
	 *  is XChaCha20-Poly1305-sealed under the entity DEK, opaque to the
	 *  relay just like `Update` frames. */
	Awareness = "awareness",
}

export type RoutingHeader = {
	v: number;
	kind: WireKind;
	entityId: string;
	sender: string;
	seq: number;
	nonce: string;
	ts: number;
	/** Collab-C5 — OPTIONAL relay routing-key override. When present the relay
	 *  fans the frame to subscribers of `route` instead of `entityId` (a
	 *  recipient inbox channel for cross-user wrap delivery). Relay-blind: it's
	 *  just an opaque routing label here. Absent on every pre-C5 frame. */
	route?: string;
};

const KIND_SET = new Set<string>(Object.values(WireKind));
const DECODER = new TextDecoder();

/**
 * Strict-shape parse of canonical routing-header bytes. Throws `Invalid`
 * (named Error, kind="Invalid") on any deviation — wrong protocol version,
 * missing field, wrong type, unknown `kind`.
 */
export function parseRoutingHeaderJson(bytes: Uint8Array): RoutingHeader {
	let parsed: unknown;
	try {
		parsed = JSON.parse(DECODER.decode(bytes));
	} catch (error) {
		throw invalid(`routing header: malformed JSON (${(error as Error).message})`);
	}
	return assertHeader(parsed);
}

/**
 * Peek the routing header of a wire-framed envelope. Throws `Invalid` on
 * any structural deviation. Does NOT decode the ciphertext (it cannot —
 * no key) and does NOT verify the signature (the recipient is the last
 * line of defense; the relay rejecting forged sigs would also work but is
 * not load-bearing here, and would require a sender-pubkey-aware ACL the
 * relay doesn't have at v1).
 *
 * Returns `{ header, byteLength }` so the relay can log `byteLength` in
 * the audit-log without re-measuring the buffer.
 */
export function peekRoutingHeader(frame: Uint8Array): {
	header: RoutingHeader;
	byteLength: number;
} {
	if (frame.length < 4) throw invalid("peekRoutingHeader: truncated header length");
	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	const headerLen = view.getUint32(0, false);
	if (headerLen <= 0 || 4 + headerLen > frame.length) {
		throw invalid("peekRoutingHeader: truncated header bytes");
	}
	const headerBytes = frame.subarray(4, 4 + headerLen);
	// Skip the rest of the frame (sig + ciphertext). The relay does NOT
	// validate sig/ct lengths — those are the receiver's job. We only
	// need the header for routing + the audit log.
	const header = parseRoutingHeaderJson(headerBytes);
	return { header, byteLength: frame.length };
}

function assertHeader(value: unknown): RoutingHeader {
	if (!value || typeof value !== "object") {
		throw invalid("routing header: not an object");
	}
	const h = value as Record<string, unknown>;
	if (h.v !== PROTOCOL_VERSION) {
		throw invalid(`routing header: unsupported v=${String(h.v)} (expected ${PROTOCOL_VERSION})`);
	}
	if (typeof h.kind !== "string" || !KIND_SET.has(h.kind)) {
		throw invalid(`routing header: unknown kind=${String(h.kind)}`);
	}
	if (typeof h.entityId !== "string" || h.entityId === "") {
		throw invalid("routing header: entityId must be a non-empty string");
	}
	if (typeof h.sender !== "string" || h.sender === "") {
		throw invalid("routing header: sender must be a non-empty string");
	}
	if (typeof h.seq !== "number" || !Number.isFinite(h.seq)) {
		throw invalid("routing header: seq must be a finite number");
	}
	if (typeof h.nonce !== "string" || h.nonce === "") {
		throw invalid("routing header: nonce must be a non-empty string");
	}
	if (typeof h.ts !== "number" || !Number.isFinite(h.ts)) {
		throw invalid("routing header: ts must be a finite number");
	}
	if (h.route !== undefined && (typeof h.route !== "string" || h.route === "")) {
		throw invalid("routing header: route must be a non-empty string when present");
	}
	return {
		v: h.v,
		kind: h.kind as WireKind,
		entityId: h.entityId,
		sender: h.sender,
		seq: h.seq,
		nonce: h.nonce,
		ts: h.ts,
		...(h.route ? { route: h.route as string } : {}),
	};
}

function invalid(message: string): Error {
	const err = new Error(message);
	err.name = "Invalid";
	return err;
}
