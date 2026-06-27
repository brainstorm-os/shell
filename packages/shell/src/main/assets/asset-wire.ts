/**
 * The blob-plane wire protocol — `WireKind.Asset` chunked transport (Asset-B2).
 *
 * The asset CAS is a request/response channel, DISTINCT from the Y.Doc relay's
 * entity-routed pub/sub (design [data/70 §The asset CAS]): three verbs keyed by
 * the ciphertext-hash of a sealed chunk — `Has` (skip already-present), `Put`
 * (upload a sealed chunk), `Get` (fetch one). The node (Asset-B3) is the
 * responder; it stays relay-blind (it sees only ciphertext keyed by
 * ciphertext-hash and never a key).
 *
 * Framing mirrors the Y.Doc envelope style — a `u32-be` length-prefixed JSON
 * header followed by the optional raw chunk payload (present on a `Put` request
 * and a found `Get` response). Keeping the header JSON keeps the validation
 * strict + debuggable; the chunk rides as opaque trailing bytes (no base64
 * bloat for MB-scale chunks).
 *
 * `WireAssetCas` adapts the {@link AssetCas} contract onto a single
 * `send(frame) → frame` round-trip transport (the WS/relay binding lands with
 * the node in Asset-B3); the transport here is injected so it's unit-testable
 * against an in-memory responder.
 */

import type { AssetCas } from "./asset-cas";

/** The asset-channel verb. A distinct namespace from the relay `WireKind` —
 *  this is the blob plane, not the metadata plane. */
export enum AssetWireKind {
	Has = "has",
	Put = "put",
	Get = "get",
}

export type AssetRequest =
	| { kind: AssetWireKind.Has; hash: string }
	| { kind: AssetWireKind.Put; hash: string; chunk: Uint8Array }
	| { kind: AssetWireKind.Get; hash: string };

export type AssetResponse =
	| { kind: AssetWireKind.Has; present: boolean }
	| { kind: AssetWireKind.Put; ok: boolean }
	| { kind: AssetWireKind.Get; found: false }
	| { kind: AssetWireKind.Get; found: true; chunk: Uint8Array };

function invalid(message: string): Error {
	const err = new Error(message);
	err.name = "Invalid";
	return err;
}

/** `u32-be(headerLen) || headerJSON || trailingChunk` — the shared frame shape. */
function frame(header: unknown, chunk?: Uint8Array): Uint8Array {
	const headerBytes = new TextEncoder().encode(JSON.stringify(header));
	const tail = chunk ?? new Uint8Array(0);
	const out = new Uint8Array(4 + headerBytes.length + tail.length);
	new DataView(out.buffer).setUint32(0, headerBytes.length, false);
	out.set(headerBytes, 4);
	out.set(tail, 4 + headerBytes.length);
	return out;
}

function unframe(bytes: Uint8Array): { header: Record<string, unknown>; chunk: Uint8Array } {
	if (!(bytes instanceof Uint8Array) || bytes.length < 4) {
		throw invalid("asset frame: too short for a length prefix");
	}
	const headerLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
		0,
		false,
	);
	if (headerLen <= 0 || 4 + headerLen > bytes.length) {
		throw invalid("asset frame: header length out of range");
	}
	let header: unknown;
	try {
		header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLen)));
	} catch {
		throw invalid("asset frame: header is not valid JSON");
	}
	if (!header || typeof header !== "object" || Array.isArray(header)) {
		throw invalid("asset frame: header is not an object");
	}
	return { header: header as Record<string, unknown>, chunk: bytes.subarray(4 + headerLen) };
}

const KINDS = new Set<string>([AssetWireKind.Has, AssetWireKind.Put, AssetWireKind.Get]);

function requireHash(h: unknown): string {
	if (typeof h !== "string" || h.length === 0) throw invalid("asset frame: missing hash");
	return h;
}

export function encodeAssetRequest(req: AssetRequest): Uint8Array {
	if (req.kind === AssetWireKind.Put) {
		return frame({ k: req.kind, hash: req.hash }, req.chunk);
	}
	return frame({ k: req.kind, hash: req.hash });
}

export function decodeAssetRequest(bytes: Uint8Array): AssetRequest {
	const { header, chunk } = unframe(bytes);
	const k = header.k;
	if (typeof k !== "string" || !KINDS.has(k)) throw invalid(`asset request: bad kind ${String(k)}`);
	const hash = requireHash(header.hash);
	if (k === AssetWireKind.Put)
		return { kind: AssetWireKind.Put, hash, chunk: new Uint8Array(chunk) };
	if (k === AssetWireKind.Get) return { kind: AssetWireKind.Get, hash };
	return { kind: AssetWireKind.Has, hash };
}

export function encodeAssetResponse(res: AssetResponse): Uint8Array {
	if (res.kind === AssetWireKind.Get && res.found) {
		return frame({ k: res.kind, found: true }, res.chunk);
	}
	if (res.kind === AssetWireKind.Get) return frame({ k: res.kind, found: false });
	if (res.kind === AssetWireKind.Has) return frame({ k: res.kind, present: res.present });
	return frame({ k: res.kind, ok: res.ok });
}

export function decodeAssetResponse(bytes: Uint8Array): AssetResponse {
	const { header, chunk } = unframe(bytes);
	const k = header.k;
	if (k === AssetWireKind.Has) return { kind: AssetWireKind.Has, present: header.present === true };
	if (k === AssetWireKind.Put) return { kind: AssetWireKind.Put, ok: header.ok === true };
	if (k === AssetWireKind.Get) {
		return header.found === true
			? { kind: AssetWireKind.Get, found: true, chunk: new Uint8Array(chunk) }
			: { kind: AssetWireKind.Get, found: false };
	}
	throw invalid(`asset response: bad kind ${String(k)}`);
}

/** A round-trip transport: send one request frame, await one response frame. */
export type AssetWireTransport = (request: Uint8Array) => Promise<Uint8Array>;

/** {@link AssetCas} over the wire — encodes each verb, sends it through the
 *  injected transport, decodes the reply. The concrete WS/relay transport is
 *  wired with the node (Asset-B3). */
export class WireAssetCas implements AssetCas {
	readonly #send: AssetWireTransport;

	constructor(send: AssetWireTransport) {
		this.#send = send;
	}

	async has(hash: string): Promise<boolean> {
		const res = decodeAssetResponse(
			await this.#send(encodeAssetRequest({ kind: AssetWireKind.Has, hash })),
		);
		return res.kind === AssetWireKind.Has && res.present;
	}

	async put(hash: string, chunk: Uint8Array): Promise<void> {
		const res = decodeAssetResponse(
			await this.#send(encodeAssetRequest({ kind: AssetWireKind.Put, hash, chunk })),
		);
		if (res.kind !== AssetWireKind.Put || !res.ok) {
			throw new Error(`WireAssetCas.put: node rejected chunk ${hash}`);
		}
	}

	async get(hash: string): Promise<Uint8Array | null> {
		const res = decodeAssetResponse(
			await this.#send(encodeAssetRequest({ kind: AssetWireKind.Get, hash })),
		);
		if (res.kind !== AssetWireKind.Get) throw new Error("WireAssetCas.get: wrong response kind");
		return res.found ? res.chunk : null;
	}
}

/** Server-side helper (used by the node, Asset-B3): decode a request, apply it
 *  to a local {@link AssetCas}, and encode the response. Pure routing — never
 *  touches a key. Exposed here so the wire protocol has ONE definition shared
 *  by both ends. */
export async function serveAssetRequest(cas: AssetCas, request: Uint8Array): Promise<Uint8Array> {
	const req = decodeAssetRequest(request);
	if (req.kind === AssetWireKind.Has) {
		return encodeAssetResponse({ kind: AssetWireKind.Has, present: await cas.has(req.hash) });
	}
	if (req.kind === AssetWireKind.Put) {
		await cas.put(req.hash, req.chunk);
		return encodeAssetResponse({ kind: AssetWireKind.Put, ok: true });
	}
	const chunk = await cas.get(req.hash);
	return encodeAssetResponse(
		chunk
			? { kind: AssetWireKind.Get, found: true, chunk }
			: { kind: AssetWireKind.Get, found: false },
	);
}
