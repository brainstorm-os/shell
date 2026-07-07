/**
 * Asset-B6b — the client half of node-side asset GC: send this device's FULL
 * converged chunk-hash ref-set to the durable node (`AssetWireKind.Refs`,
 * idempotent replace per `(account, device)`), feeding the conservative
 * mark-and-sweep Asset-B6 shipped node-side (grace-mark + last-seen guard).
 *
 * Correctness posture — **never under-report**:
 *   - The wire has no paging: one frame IS the device's full set (a second
 *     frame would REPLACE it). A set that won't fit under the transport's
 *     frame ceiling is therefore NOT sent (skip + warn) — the node's
 *     last-seen guard keeps this device's chunks alive; wire paging is the
 *     follow-up if real vaults ever get there (~16k chunk hashes ≈ 1 MiB).
 *   - A manifest that fails to read or parse aborts the WHOLE report: a
 *     spuriously smaller set is the one thing that could mark a live chunk,
 *     while a missing report merely delays GC. Fail closed toward retention.
 *
 * The ref-set derives from the same source the upload drain walks: every
 * `(entityId, assetId)` pair in `asset_refs` (kept converged by the B4 bind
 * writer + B5 cold reconstruction), each pair's chunk manifest read off the
 * entity Y.Doc. Pure against injected deps; the index.ts wiring supplies the
 * repository, the ydoc reader, and the relay transport.
 */

import { parseAssetChunkManifest } from "./asset-chunks";
import {
	AssetWireKind,
	type AssetWireTransport,
	decodeAssetResponse,
	encodeAssetRequest,
	refsFrameBytes,
} from "./asset-wire";

/** The relay's asset-frame ceiling this sender stays under. Matches the
 *  node/relay `maxFrameBytes` posture (1 MiB); ~16k chunk hashes. */
export const DEFAULT_MAX_REFS_FRAME_BYTES = 1024 * 1024;

export type RefReportDeps = {
	/** Every `(entityId, assetId)` pair in `asset_refs` (`listAllPairs`). */
	listPairs: () => Array<{ entityId: string; assetId: string }>;
	/** The pair's raw chunk manifest off the entity Y.Doc, or null. */
	readManifest: (entityId: string, assetId: string) => Promise<unknown>;
	send: AssetWireTransport;
	/** The wire account — the device's sender identity (base64url pubkey);
	 *  a gated node overrides it with the proven account. */
	account: string;
	/** Stable per-device id (device Ed25519 pub, base64). */
	device: string;
	maxFrameBytes?: number;
	log?: (message: string) => void;
};

export enum RefReportOutcome {
	Sent = "sent",
	/** The full set exceeds one frame — not sent (never a partial). */
	TooLarge = "too-large",
	/** A manifest read/parse failed — not sent (never an under-report). */
	Aborted = "aborted",
	/** The node answered but did not ack the full count. */
	Rejected = "rejected",
}

export type RefReportResult = {
	outcome: RefReportOutcome;
	/** Distinct chunk hashes in the converged set (computed even when not sent). */
	hashes: number;
	/** Pairs whose manifest hasn't landed yet (upload pending) — fine to skip:
	 *  their chunks aren't on the node under this device's authorship yet, and
	 *  the next drain-triggered report picks them up. */
	pendingManifests: number;
};

/**
 * Collect the converged chunk-hash set and send it as ONE Refs frame.
 *
 * A `null` manifest (not yet uploaded/synced for that pair) is skipped — the
 * chunks it would name aren't referenceable on the node yet. Any read that
 * THROWS or any non-null manifest that fails validation aborts the report
 * (see module header). Hashes are sorted for a deterministic frame.
 */
export async function sendAssetRefReport(deps: RefReportDeps): Promise<RefReportResult> {
	const log = deps.log ?? ((m: string) => console.warn(m));
	const maxFrameBytes = deps.maxFrameBytes ?? DEFAULT_MAX_REFS_FRAME_BYTES;

	const hashes = new Set<string>();
	let pendingManifests = 0;
	for (const pair of deps.listPairs()) {
		let raw: unknown;
		try {
			raw = await deps.readManifest(pair.entityId, pair.assetId);
		} catch (error) {
			log(
				`[assets] ref report aborted: manifest read failed for ${pair.entityId}/${pair.assetId}: ${(error as Error).message}`,
			);
			return { outcome: RefReportOutcome.Aborted, hashes: hashes.size, pendingManifests };
		}
		if (raw === null || raw === undefined) {
			pendingManifests += 1;
			continue;
		}
		const manifest = parseAssetChunkManifest(raw);
		if (!manifest) {
			log(`[assets] ref report aborted: unparseable manifest for ${pair.entityId}/${pair.assetId}`);
			return { outcome: RefReportOutcome.Aborted, hashes: hashes.size, pendingManifests };
		}
		for (const chunk of manifest.chunks) hashes.add(chunk.hash);
	}

	const sorted = [...hashes].sort();
	const frameBytes = refsFrameBytes(deps.account, deps.device, sorted.length);
	if (frameBytes > maxFrameBytes) {
		log(
			`[assets] ref report skipped: ${sorted.length} hashes (${frameBytes}B) exceed the ${maxFrameBytes}B frame ceiling — node GC relies on the last-seen guard until wire paging lands`,
		);
		return { outcome: RefReportOutcome.TooLarge, hashes: sorted.length, pendingManifests };
	}

	const response = decodeAssetResponse(
		await deps.send(
			encodeAssetRequest({
				kind: AssetWireKind.Refs,
				account: deps.account,
				device: deps.device,
				hashes: sorted,
			}),
		),
	);
	const acked =
		response.kind === AssetWireKind.Refs && response.ok && response.count === sorted.length;
	return {
		outcome: acked ? RefReportOutcome.Sent : RefReportOutcome.Rejected,
		hashes: sorted.length,
		pendingManifests,
	};
}
