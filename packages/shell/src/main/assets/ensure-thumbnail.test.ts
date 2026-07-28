/**
 * Asset-B4b — the derive-and-bind orchestration: eligibility, idempotence,
 * the lost-race cleanup, and (crucially) that nothing here can fail a bind.
 */
import { describe, expect, it, vi } from "vitest";
import type { AssetRecord } from "../storage/entities-repo/assets-repo";
import { AssetKind } from "./asset-types";
import {
	type EnsureThumbnailDeps,
	EnsureThumbnailOutcome,
	ensureThumbnailForBoundAsset,
} from "./ensure-thumbnail";
import { THUMBNAIL_MIN_SOURCE_BYTES } from "./thumbnailer";

const ENTITY = "ent-1";
const PARENT = "asset-parent";

function row(overrides: Partial<AssetRecord> = {}): AssetRecord {
	return {
		assetId: PARENT,
		dekId: "dek-1",
		contentHash: "h",
		mime: "image/png",
		byteLen: THUMBNAIL_MIN_SOURCE_BYTES * 4,
		kind: AssetKind.Upload,
		originUrl: null,
		createdAt: 1,
		boundAt: 2,
		thumbAssetId: null,
		...overrides,
	};
}

function makeDeps(overrides: Partial<EnsureThumbnailDeps> = {}): EnsureThumbnailDeps & {
	created: string[];
	bound: Array<{ entityId: string; assetId: string }>;
	deleted: string[];
} {
	const created: string[] = [];
	const bound: Array<{ entityId: string; assetId: string }> = [];
	const deleted: string[] = [];
	return {
		created,
		bound,
		deleted,
		getAsset: () => row(),
		readAsset: async () => ({ bytes: new Uint8Array(200_000), mime: "image/png" }),
		thumbnailer: async () => ({ bytes: new Uint8Array([9, 9]), mime: "image/jpeg" }),
		writeThumbAsset: async () => {
			created.push("thumb-new");
			return { assetId: "thumb-new" };
		},
		linkThumb: () => true,
		deleteAsset: async (id) => {
			deleted.push(id);
		},
		createRef: (entityId, assetId) => {
			bound.push({ entityId, assetId });
			return true;
		},
		...overrides,
	};
}

describe("ensureThumbnailForBoundAsset", () => {
	it("derives, stores, links, binds, and pushes for an eligible image", async () => {
		const pushed: string[] = [];
		const deps = makeDeps({ onThumbBound: (_e, id) => pushed.push(id) });
		const outcome = await ensureThumbnailForBoundAsset(deps, ENTITY, PARENT);
		expect(outcome).toBe(EnsureThumbnailOutcome.Created);
		expect(deps.created).toEqual(["thumb-new"]);
		expect(deps.bound).toEqual([{ entityId: ENTITY, assetId: "thumb-new" }]);
		expect(pushed).toEqual(["thumb-new"]);
	});

	it("short-circuits an already-linked parent, ensuring only THIS entity's ref", async () => {
		const deps = makeDeps({ getAsset: () => row({ thumbAssetId: "thumb-old" }) });
		const outcome = await ensureThumbnailForBoundAsset(deps, ENTITY, PARENT);
		expect(outcome).toBe(EnsureThumbnailOutcome.AlreadyPresent);
		expect(deps.created).toEqual([]);
		expect(deps.bound).toEqual([{ entityId: ENTITY, assetId: "thumb-old" }]);
	});

	it("does not re-push when the ref already existed (createRef → false)", async () => {
		const pushed: string[] = [];
		const deps = makeDeps({
			getAsset: () => row({ thumbAssetId: "thumb-old" }),
			createRef: () => false,
			onThumbBound: (_e, id) => pushed.push(id),
		});
		await ensureThumbnailForBoundAsset(deps, ENTITY, PARENT);
		expect(pushed).toEqual([]);
	});

	it("passes through non-eligible assets untouched (missing row / thumbnail / non-image / tiny)", async () => {
		for (const getAsset of [
			() => null,
			() => row({ kind: AssetKind.Thumbnail }),
			() => row({ mime: "application/pdf" }),
			() => row({ mime: "image/svg+xml" }),
			() => row({ byteLen: THUMBNAIL_MIN_SOURCE_BYTES }),
		]) {
			const deps = makeDeps({ getAsset });
			expect(await ensureThumbnailForBoundAsset(deps, ENTITY, PARENT)).toBe(
				EnsureThumbnailOutcome.NotEligible,
			);
			expect(deps.created).toEqual([]);
			expect(deps.bound).toEqual([]);
		}
	});

	it("a cold device (blob not local) never derives", async () => {
		const deps = makeDeps({ readAsset: async () => null });
		expect(await ensureThumbnailForBoundAsset(deps, ENTITY, PARENT)).toBe(
			EnsureThumbnailOutcome.NotLocal,
		);
	});

	it("a declining thumbnailer (addon absent / undecodable) leaves everything untouched", async () => {
		const deps = makeDeps({ thumbnailer: async () => null });
		expect(await ensureThumbnailForBoundAsset(deps, ENTITY, PARENT)).toBe(
			EnsureThumbnailOutcome.Declined,
		);
		expect(deps.created).toEqual([]);
		expect(deps.bound).toEqual([]);
	});

	it("a lost link race deletes the orphan and binds the winner", async () => {
		const deps = makeDeps({
			linkThumb: () => false,
			getAsset: vi
				.fn<() => AssetRecord | null>()
				// First read: no link yet (we derive); post-race read: winner linked.
				.mockReturnValueOnce(row())
				.mockReturnValue(row({ thumbAssetId: "thumb-winner" })),
		});
		const outcome = await ensureThumbnailForBoundAsset(deps, ENTITY, PARENT);
		expect(outcome).toBe(EnsureThumbnailOutcome.LostRace);
		expect(deps.deleted).toEqual(["thumb-new"]);
		expect(deps.bound).toEqual([{ entityId: ENTITY, assetId: "thumb-winner" }]);
	});

	it("a throwing onThumbBound hook is contained", async () => {
		const deps = makeDeps({
			onThumbBound: () => {
				throw new Error("boom");
			},
		});
		expect(await ensureThumbnailForBoundAsset(deps, ENTITY, PARENT)).toBe(
			EnsureThumbnailOutcome.Created,
		);
	});
});
