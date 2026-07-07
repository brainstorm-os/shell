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
	/** Asset-B6 — a device's full-set ref report (idempotent replace). */
	Refs = "refs",
}

/** Bounds on the Refs identity strings — mirrors the node's validation
 *  (the account is a base64url pubkey ≤ ~64 chars; the device id is a
 *  client-minted opaque id). */
const MAX_ACCOUNT_CHARS = 256;
const MAX_DEVICE_CHARS = 128;
const HEX_HASH_CHARS = 64;
const HEX_HASH_RE = /^[0-9a-f]{64}$/;

export type AssetRequest =
	| { kind: AssetWireKind.Has; hash: string }
	| { kind: AssetWireKind.Put; hash: string; chunk: Uint8Array }
	| { kind: AssetWireKind.Get; hash: string }
	| { kind: AssetWireKind.Refs; account: string; device: string; hashes: string[] };

export type AssetResponse =
	| { kind: AssetWireKind.Has; present: boolean }
	| { kind: AssetWireKind.Put; ok: boolean }
	| { kind: AssetWireKind.Get; found: false }
	| { kind: AssetWireKind.Get; found: true; chunk: Uint8Array }
	| { kind: AssetWireKind.Refs; ok: boolean; count: number };

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

const KINDS = new Set<string>([
	AssetWireKind.Has,
	AssetWireKind.Put,
	AssetWireKind.Get,
	AssetWireKind.Refs,
]);

function requireHash(h: unknown): string {
	if (typeof h !== "string" || h.length === 0) throw invalid("asset frame: missing hash");
	return h;
}

function nonEmptyString(v: unknown, max: number): v is string {
	return typeof v === "string" && v.length > 0 && v.length <= max;
}

/** Asset-B6 — the ref-set rides as the trailing chunk: concatenated 64-hex
 *  ASCII addresses (a large report never bloats the JSON header). */
function encodeRefSet(hashes: readonly string[]): Uint8Array {
	for (const h of hashes) {
		if (!HEX_HASH_RE.test(h)) throw invalid("asset request: ref-set entry must be 64-hex");
	}
	return new TextEncoder().encode(hashes.join(""));
}

function decodeRefSet(chunk: Uint8Array): string[] {
	if (chunk.length % HEX_HASH_CHARS !== 0) {
		throw invalid("asset request: ref-set length must be a multiple of 64");
	}
	const text = new TextDecoder().decode(chunk);
	const hashes: string[] = [];
	for (let i = 0; i < text.length; i += HEX_HASH_CHARS) {
		const hash = text.slice(i, i + HEX_HASH_CHARS);
		if (!HEX_HASH_RE.test(hash)) throw invalid("asset request: ref-set entry must be 64-hex");
		hashes.push(hash);
	}
	return hashes;
}

/** The encoded size of a Refs frame for `count` hashes — lets the sender
 *  refuse to build a frame past the transport's ceiling BEFORE allocating
 *  it. Mirrors `frame()`: u32 prefix + JSON header + 64 ASCII bytes/hash. */
export function refsFrameBytes(account: string, device: string, count: number): number {
	const headerBytes = new TextEncoder().encode(
		JSON.stringify({ k: AssetWireKind.Refs, account, device }),
	).length;
	return 4 + headerBytes + count * HEX_HASH_CHARS;
}

export function encodeAssetRequest(req: AssetRequest): Uint8Array {
	if (req.kind === AssetWireKind.Refs) {
		return frame({ k: req.kind, account: req.account, device: req.device }, encodeRefSet(req.hashes));
	}
	if (req.kind === AssetWireKind.Put) {
		return frame({ k: req.kind, hash: req.hash }, req.chunk);
	}
	return frame({ k: req.kind, hash: req.hash });
}

export function decodeAssetRequest(bytes: Uint8Array): AssetRequest {
	const { header, chunk } = unframe(bytes);
	const k = header.k;
	if (typeof k !== "string" || !KINDS.has(k)) throw invalid(`asset request: bad kind ${String(k)}`);
	if (k === AssetWireKind.Refs) {
		if (!nonEmptyString(header.account, MAX_ACCOUNT_CHARS)) {
			throw invalid("asset request: refs needs an account");
		}
		if (!nonEmptyString(header.device, MAX_DEVICE_CHARS)) {
			throw invalid("asset request: refs needs a device id");
		}
		return {
			kind: AssetWireKind.Refs,
			account: header.account,
			device: header.device,
			hashes: decodeRefSet(chunk),
		};
	}
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
	if (res.kind === AssetWireKind.Refs) {
		return frame({ k: res.kind, ok: res.ok, count: res.count });
	}
	return frame({ k: res.kind, ok: res.ok });
}

export function decodeAssetResponse(bytes: Uint8Array): AssetResponse {
	const { header, chunk } = unframe(bytes);
	const k = header.k;
	if (k === AssetWireKind.Has) return { kind: AssetWireKind.Has, present: header.present === true };
	if (k === AssetWireKind.Put) return { kind: AssetWireKind.Put, ok: header.ok === true };
	if (k === AssetWireKind.Refs) {
		return {
			kind: AssetWireKind.Refs,
			ok: header.ok === true,
			count: typeof header.count === "number" && Number.isFinite(header.count) ? header.count : 0,
		};
	}
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
	if (req.kind === AssetWireKind.Refs) {
		// The plain-CAS responder has no GC plane — same fail-shape as the
		// node without one (the real node's copy routes to its GC hooks).
		throw invalid("asset request: refs unsupported (no GC plane)");
	}
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
