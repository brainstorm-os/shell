import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { makeEnvelope } from "../../ipc/envelope";
import {
	__ydocCacheResetForTest,
	__ydocCacheSizeForTest,
	handleParentPortMessage,
	handleYDocEnvelope,
} from "./index";

function mk(method: string, args: unknown) {
	return makeEnvelope({
		msg: `m${Math.random().toString(36).slice(2, 8)}`,
		app: "shell",
		service: "ydoc",
		method,
		args: [args],
		caps: [],
	});
}

function captureUpdate(doc: Y.Doc, mutate: () => void): Uint8Array {
	let captured: Uint8Array | null = null;
	const handler = (update: Uint8Array) => {
		captured = update;
	};
	doc.on("update", handler);
	try {
		mutate();
	} finally {
		doc.off("update", handler);
	}
	if (!captured) throw new Error("expected an update");
	return captured;
}

describe("ydoc worker", () => {
	let vaultDir: string;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-ydocworker-"));
	});

	afterEach(async () => {
		await rm(vaultDir, { recursive: true, force: true });
	});

	it("load() on a fresh entity returns an empty snapshot", async () => {
		const reply = await handleYDocEnvelope(
			mk("load", { vaultPath: vaultDir, entityId: "ent_fresh" }),
		);
		expect(reply.ok).toBe(true);
		if (!reply.ok) throw new Error("expected ok");
		const value = reply.value as { snapshotB64: string; truncatedTail: boolean };
		expect(value.truncatedTail).toBe(false);
		expect(typeof value.snapshotB64).toBe("string");
	});

	it("applyUpdate persists + later load recovers the state", async () => {
		const writer = new Y.Doc();
		const u = captureUpdate(writer, () => writer.getText("body").insert(0, "hello"));
		await handleYDocEnvelope(mk("load", { vaultPath: vaultDir, entityId: "ent_a" }));
		const apply = await handleYDocEnvelope(
			mk("applyUpdate", {
				vaultPath: vaultDir,
				entityId: "ent_a",
				updateB64: Buffer.from(u).toString("base64"),
			}),
		);
		expect(apply.ok).toBe(true);

		// Close the in-memory replica then load again — must come from disk.
		await handleYDocEnvelope(mk("close", { vaultPath: vaultDir, entityId: "ent_a" }));
		const reply = await handleYDocEnvelope(mk("load", { vaultPath: vaultDir, entityId: "ent_a" }));
		if (!reply.ok) throw new Error("expected ok");
		const value = reply.value as { snapshotB64: string };
		const reader = new Y.Doc();
		Y.applyUpdate(reader, new Uint8Array(Buffer.from(value.snapshotB64, "base64")));
		expect(reader.getText("body").toString()).toBe("hello");
	});

	it("snapshot() returns the current full state", async () => {
		const writer = new Y.Doc();
		const u = captureUpdate(writer, () => writer.getText("t").insert(0, "abc"));
		await handleYDocEnvelope(
			mk("applyUpdate", {
				vaultPath: vaultDir,
				entityId: "ent_snap",
				updateB64: Buffer.from(u).toString("base64"),
			}),
		);
		const reply = await handleYDocEnvelope(
			mk("snapshot", { vaultPath: vaultDir, entityId: "ent_snap" }),
		);
		if (!reply.ok) throw new Error("expected ok");
		const { snapshotB64 } = reply.value as { snapshotB64: string };
		const reader = new Y.Doc();
		Y.applyUpdate(reader, new Uint8Array(Buffer.from(snapshotB64, "base64")));
		expect(reader.getText("t").toString()).toBe("abc");
	});

	it("recover() reports the on-disk tail entry count", async () => {
		const writer = new Y.Doc();
		for (let i = 0; i < 3; i++) {
			const u = captureUpdate(writer, () => writer.getArray("xs").push([i]));
			await handleYDocEnvelope(
				mk("applyUpdate", {
					vaultPath: vaultDir,
					entityId: "ent_rec",
					updateB64: Buffer.from(u).toString("base64"),
				}),
			);
		}
		const reply = await handleYDocEnvelope(
			mk("recover", { vaultPath: vaultDir, entityId: "ent_rec" }),
		);
		if (!reply.ok) throw new Error("expected ok");
		const { tailEntries, truncatedTail } = reply.value as {
			tailEntries: number;
			truncatedTail: boolean;
		};
		expect(tailEntries).toBe(3);
		expect(truncatedTail).toBe(false);
	});

	it("installAssetDekWrap() stores a wrap keyed by assetId, idempotent on re-call", async () => {
		const wrap = { v: 1 as const, nonceB64: "AAAA", ciphertextB64: "BBBB" };
		const first = await handleYDocEnvelope(
			mk("installAssetDekWrap", {
				vaultPath: vaultDir,
				entityId: "ent_assets",
				assetId: "asset-1",
				wrap,
			}),
		);
		if (!first.ok) throw new Error("expected ok");
		expect((first.value as { appended: boolean }).appended).toBe(true);

		// A second call for the same assetId is a no-op (no second update).
		const second = await handleYDocEnvelope(
			mk("installAssetDekWrap", {
				vaultPath: vaultDir,
				entityId: "ent_assets",
				assetId: "asset-1",
				wrap,
			}),
		);
		if (!second.ok) throw new Error("expected ok");
		expect((second.value as { appended: boolean }).appended).toBe(false);

		// The wrap survives a reload and lives under brainstorm.meta → assetDeks.
		const reload = await handleYDocEnvelope(
			mk("snapshot", { vaultPath: vaultDir, entityId: "ent_assets" }),
		);
		if (!reload.ok) throw new Error("expected ok");
		const reader = new Y.Doc();
		Y.applyUpdate(
			reader,
			new Uint8Array(Buffer.from((reload.value as { snapshotB64: string }).snapshotB64, "base64")),
		);
		const meta = reader.getMap<unknown>("brainstorm.meta");
		const map = meta.get("assetDeks") as Y.Map<unknown>;
		expect(map.get("asset-1")).toEqual(wrap);
	});

	it("installAssetManifest() stores a manifest keyed by assetId, idempotent, readable back", async () => {
		const manifest = {
			v: 1,
			assetId: "asset-m1",
			chunkBytes: 16,
			totalRawLen: 20,
			chunks: [
				{ hash: "a".repeat(64), encLen: 40, rawLen: 16 },
				{ hash: "b".repeat(64), encLen: 24, rawLen: 4 },
			],
		};
		const first = await handleYDocEnvelope(
			mk("installAssetManifest", {
				vaultPath: vaultDir,
				entityId: "ent_man",
				assetId: "asset-m1",
				manifest,
			}),
		);
		if (!first.ok) throw new Error("expected ok");
		expect((first.value as { appended: boolean }).appended).toBe(true);

		// Idempotent — a second install for the same assetId is a no-op.
		const second = await handleYDocEnvelope(
			mk("installAssetManifest", {
				vaultPath: vaultDir,
				entityId: "ent_man",
				assetId: "asset-m1",
				manifest,
			}),
		);
		if (!second.ok) throw new Error("expected ok");
		expect((second.value as { appended: boolean }).appended).toBe(false);

		// Read it back (the lazy-fetch path).
		const read = await handleYDocEnvelope(
			mk("readAssetManifest", { vaultPath: vaultDir, entityId: "ent_man", assetId: "asset-m1" }),
		);
		if (!read.ok) throw new Error("expected ok");
		expect((read.value as { manifest: unknown }).manifest).toEqual(manifest);

		// A missing assetId reads back null.
		const miss = await handleYDocEnvelope(
			mk("readAssetManifest", { vaultPath: vaultDir, entityId: "ent_man", assetId: "asset-absent" }),
		);
		if (!miss.ok) throw new Error("expected ok");
		expect((miss.value as { manifest: unknown }).manifest).toBeNull();

		// It lives under brainstorm.meta → assetManifests and survives a reload.
		const reload = await handleYDocEnvelope(
			mk("snapshot", { vaultPath: vaultDir, entityId: "ent_man" }),
		);
		if (!reload.ok) throw new Error("expected ok");
		const reader = new Y.Doc();
		Y.applyUpdate(
			reader,
			new Uint8Array(Buffer.from((reload.value as { snapshotB64: string }).snapshotB64, "base64")),
		);
		const map = reader.getMap<unknown>("brainstorm.meta").get("assetManifests") as Y.Map<unknown>;
		expect(map.get("asset-m1")).toEqual(manifest);
	});

	it("listAssetManifests() returns every pair for the reconstruction pass (Asset-B5)", async () => {
		const manifestOf = (assetId: string) => ({
			v: 1,
			assetId,
			chunkBytes: 16,
			totalRawLen: 4,
			chunks: [{ hash: "c".repeat(64), encLen: 24, rawLen: 4 }],
		});
		for (const id of ["asset-l1", "asset-l2"]) {
			const r = await handleYDocEnvelope(
				mk("installAssetManifest", {
					vaultPath: vaultDir,
					entityId: "ent_list",
					assetId: id,
					manifest: manifestOf(id),
				}),
			);
			if (!r.ok) throw new Error("expected ok");
		}
		const list = await handleYDocEnvelope(
			mk("listAssetManifests", { vaultPath: vaultDir, entityId: "ent_list" }),
		);
		if (!list.ok) throw new Error("expected ok");
		const pairs = (list.value as { manifests: Array<{ assetId: string; manifest: unknown }> })
			.manifests;
		expect(pairs.map((p) => p.assetId).sort()).toEqual(["asset-l1", "asset-l2"]);
		expect(pairs.find((p) => p.assetId === "asset-l1")?.manifest).toEqual(manifestOf("asset-l1"));

		// An entity with no manifests lists empty (not an error).
		const none = await handleYDocEnvelope(
			mk("listAssetManifests", { vaultPath: vaultDir, entityId: "ent_list_none" }),
		);
		if (!none.ok) throw new Error("expected ok");
		expect((none.value as { manifests: unknown[] }).manifests).toEqual([]);
	});

	it("installAssetManifest() rejects a non-object manifest", async () => {
		const reply = await handleYDocEnvelope(
			mk("installAssetManifest", {
				vaultPath: vaultDir,
				entityId: "ent_badm",
				assetId: "asset-x",
				manifest: "nope",
			}),
		);
		expect(reply.ok).toBe(false);
	});

	it("readAssetDekWrap() reads back an installed wrap; null when absent/malformed", async () => {
		const wrap = { v: 1 as const, nonceB64: "Tk9OQ0U", ciphertextB64: "Q1RYVA" };
		await handleYDocEnvelope(
			mk("installAssetDekWrap", { vaultPath: vaultDir, entityId: "ent_rw", assetId: "asset-w", wrap }),
		);
		const read = await handleYDocEnvelope(
			mk("readAssetDekWrap", { vaultPath: vaultDir, entityId: "ent_rw", assetId: "asset-w" }),
		);
		if (!read.ok) throw new Error("expected ok");
		expect((read.value as { wrap: unknown }).wrap).toEqual(wrap);

		const miss = await handleYDocEnvelope(
			mk("readAssetDekWrap", { vaultPath: vaultDir, entityId: "ent_rw", assetId: "asset-absent" }),
		);
		if (!miss.ok) throw new Error("expected ok");
		expect((miss.value as { wrap: unknown }).wrap).toBeNull();

		const noEntity = await handleYDocEnvelope(
			mk("readAssetDekWrap", { vaultPath: vaultDir, entityId: "ent_norw", assetId: "asset-w" }),
		);
		if (!noEntity.ok) throw new Error("expected ok");
		expect((noEntity.value as { wrap: unknown }).wrap).toBeNull();
	});

	it("readAssetManifest() returns null for an entity with no manifests", async () => {
		const reply = await handleYDocEnvelope(
			mk("readAssetManifest", { vaultPath: vaultDir, entityId: "ent_none", assetId: "asset-x" }),
		);
		if (!reply.ok) throw new Error("expected ok");
		expect((reply.value as { manifest: unknown }).manifest).toBeNull();
	});

	it("installAssetDekWrap() rejects a malformed wrap shape", async () => {
		const reply = await handleYDocEnvelope(
			mk("installAssetDekWrap", {
				vaultPath: vaultDir,
				entityId: "ent_bad",
				assetId: "asset-x",
				wrap: { v: 1, nonceB64: 5 },
			}),
		);
		expect(reply.ok).toBe(false);
	});

	it("rejects unknown methods with Unavailable", async () => {
		const reply = await handleYDocEnvelope(
			mk("doesNotExist", { vaultPath: vaultDir, entityId: "ent_x" }),
		);
		expect(reply.ok).toBe(false);
		if (reply.ok) throw new Error("expected error reply");
		expect(reply.error.kind).toBe("Unavailable");
	});

	it("rejects envelopes routed to the wrong service", async () => {
		const wrongService = makeEnvelope({
			msg: "wrong-svc",
			app: "shell",
			service: "storage",
			method: "load",
			args: [{ vaultPath: vaultDir, entityId: "ent_x" }],
			caps: [],
		});
		const reply = await handleYDocEnvelope(wrongService);
		expect(reply.ok).toBe(false);
		if (reply.ok) throw new Error("expected error reply");
		expect(reply.error.kind).toBe("Invalid");
	});

	it("rejects malformed envelopes", async () => {
		const reply = await handleYDocEnvelope({ shape: "wrong" });
		expect(reply.ok).toBe(false);
		if (reply.ok) throw new Error("expected error reply");
		expect(reply.error.kind).toBe("Invalid");
	});

	it("rejects calls missing the argument object", async () => {
		const noArgs = makeEnvelope({
			msg: "no-args",
			app: "shell",
			service: "ydoc",
			method: "load",
			args: [],
			caps: [],
		});
		const reply = await handleYDocEnvelope(noArgs);
		expect(reply.ok).toBe(false);
	});

	// 10.9b defense-in-depth — the worker is the single persistence funnel
	// (entityId → YDocStore.pathFor → mkdir/writeFile). A traversing id must
	// be rejected here too, so a future caller that forgets the service-side
	// guard still can't escape the vault docs dir.
	it("rejects a path-traversing entityId on every persistence handler", async () => {
		for (const method of ["load", "applyUpdate", "setEntityState", "close", "recover"]) {
			const reply = await handleYDocEnvelope(
				mk(method, { vaultPath: vaultDir, entityId: "../../../../tmp/evil", updateB64: "" }),
			);
			expect(reply.ok).toBe(false);
		}
	});

	describe("doc-cache LRU", () => {
		beforeEach(() => {
			__ydocCacheResetForTest(2);
		});

		afterEach(() => {
			__ydocCacheResetForTest();
		});

		it("evicts the least-recently-used doc once the cap is exceeded", async () => {
			await handleYDocEnvelope(mk("load", { vaultPath: vaultDir, entityId: "ent_a" }));
			await handleYDocEnvelope(mk("load", { vaultPath: vaultDir, entityId: "ent_b" }));
			expect(__ydocCacheSizeForTest()).toBe(2);
			await handleYDocEnvelope(mk("load", { vaultPath: vaultDir, entityId: "ent_c" }));
			expect(__ydocCacheSizeForTest()).toBe(2);
		});

		it("touch-on-use keeps the recently-used doc resident across an eviction", async () => {
			const writer = new Y.Doc();
			const u = captureUpdate(writer, () => writer.getText("t").insert(0, "live"));
			await handleYDocEnvelope(
				mk("applyUpdate", {
					vaultPath: vaultDir,
					entityId: "ent_keep",
					updateB64: Buffer.from(u).toString("base64"),
				}),
			);
			await handleYDocEnvelope(mk("load", { vaultPath: vaultDir, entityId: "ent_filler" }));
			// Touch ent_keep so it becomes the most-recently-used. ent_filler now sits
			// at the head of the LRU and should be evicted by the next load.
			await handleYDocEnvelope(mk("snapshot", { vaultPath: vaultDir, entityId: "ent_keep" }));
			await handleYDocEnvelope(mk("load", { vaultPath: vaultDir, entityId: "ent_new" }));
			// ent_keep is still resident — a snapshot must succeed without reloading
			// from disk, and the doc state is intact.
			const reply = await handleYDocEnvelope(
				mk("snapshot", { vaultPath: vaultDir, entityId: "ent_keep" }),
			);
			if (!reply.ok) throw new Error("expected ok");
			const reader = new Y.Doc();
			Y.applyUpdate(
				reader,
				new Uint8Array(Buffer.from((reply.value as { snapshotB64: string }).snapshotB64, "base64")),
			);
			expect(reader.getText("t").toString()).toBe("live");
		});

		it("close() destroys + removes the cached doc", async () => {
			await handleYDocEnvelope(mk("load", { vaultPath: vaultDir, entityId: "ent_close" }));
			expect(__ydocCacheSizeForTest()).toBe(1);
			await handleYDocEnvelope(mk("close", { vaultPath: vaultDir, entityId: "ent_close" }));
			expect(__ydocCacheSizeForTest()).toBe(0);
		});

		it("evicted doc reloads cleanly from disk on next access", async () => {
			const writer = new Y.Doc();
			const u = captureUpdate(writer, () => writer.getText("t").insert(0, "disk"));
			await handleYDocEnvelope(
				mk("applyUpdate", {
					vaultPath: vaultDir,
					entityId: "ent_evicted",
					updateB64: Buffer.from(u).toString("base64"),
				}),
			);
			// Force eviction of ent_evicted by overflowing the LRU.
			await handleYDocEnvelope(mk("load", { vaultPath: vaultDir, entityId: "ent_b" }));
			await handleYDocEnvelope(mk("load", { vaultPath: vaultDir, entityId: "ent_c" }));
			// ent_evicted has been pushed out. Re-load must come from disk.
			const reply = await handleYDocEnvelope(
				mk("load", { vaultPath: vaultDir, entityId: "ent_evicted" }),
			);
			if (!reply.ok) throw new Error("expected ok");
			const reader = new Y.Doc();
			Y.applyUpdate(
				reader,
				new Uint8Array(Buffer.from((reply.value as { snapshotB64: string }).snapshotB64, "base64")),
			);
			expect(reader.getText("t").toString()).toBe("disk");
		});
	});

	// Electron's `process.parentPort` delivers a MessageEvent (`{ data, ports }`)
	// to the child's 'message' listener — not the raw posted value. Mirrors the
	// regression covered by the storage worker test.
	it("handleParentPortMessage unwraps the MessageEvent .data field", async () => {
		const envelope = mk("load", { vaultPath: vaultDir, entityId: "ent_pp" });
		const reply = await handleParentPortMessage({ data: envelope });
		expect(reply.ok).toBe(true);
		expect(reply.msg).toBe(envelope.msg);
	});
});
