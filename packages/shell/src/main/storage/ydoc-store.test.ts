import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DEFAULT_COMPACT_THRESHOLD, YDocStore } from "./ydoc-store";

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

describe("YDocStore", () => {
	let vaultDir: string;
	let store: YDocStore;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-ydoc-"));
		store = new YDocStore(vaultDir);
	});

	afterEach(async () => {
		await rm(vaultDir, { recursive: true, force: true });
	});

	it("load() on a missing file returns an empty doc", async () => {
		const result = await store.load("ent_missing");
		expect(result.tailEntries).toBe(0);
		expect(result.truncatedTail).toBe(false);
		expect(result.doc.getText("body").toString()).toBe("");
	});

	it("appendUpdate creates the file and stores an update that load() recovers", async () => {
		const writer = new Y.Doc();
		const update = captureUpdate(writer, () => {
			writer.getText("body").insert(0, "hello");
		});
		await store.appendUpdate("ent_a", update);
		const result = await store.load("ent_a");
		expect(result.tailEntries).toBe(1);
		expect(result.doc.getText("body").toString()).toBe("hello");
	});

	it("multiple appends apply in order", async () => {
		const writer = new Y.Doc();
		await store.appendUpdate(
			"ent_a",
			captureUpdate(writer, () => writer.getText("body").insert(0, "hi ")),
		);
		await store.appendUpdate(
			"ent_a",
			captureUpdate(writer, () => writer.getText("body").insert(3, "there")),
		);
		const result = await store.load("ent_a");
		expect(result.tailEntries).toBe(2);
		expect(result.doc.getText("body").toString()).toBe("hi there");
	});

	it("shards by 3-char id prefix", () => {
		expect(store.pathFor("ent_abcde")).toMatch(/data\/docs\/ent\/ent_abcde\.ydoc$/);
	});

	// 10.9b backstop — even if an upstream guard were bypassed, pathFor must
	// refuse any id that resolves outside the vault docs dir (path traversal).
	it("pathFor throws on an id that escapes the docs directory", () => {
		for (const id of ["../../../../tmp/evil", "..", "../../etc/passwd"]) {
			expect(() => store.pathFor(id)).toThrow(/escapes the docs directory/);
		}
	});

	it("compact() merges tail into snapshot and drops tail entries", async () => {
		const writer = new Y.Doc();
		for (let i = 0; i < 5; i++) {
			const u = captureUpdate(writer, () => writer.getArray("xs").push([i]));
			await store.appendUpdate("ent_compact", u);
		}
		const before = await store.load("ent_compact");
		expect(before.tailEntries).toBe(5);
		await store.compact("ent_compact");
		const after = await store.load("ent_compact");
		expect(after.tailEntries).toBe(0);
		expect(after.doc.getArray("xs").toArray()).toEqual([0, 1, 2, 3, 4]);
	});

	it("compact() is a no-op on a missing file", async () => {
		const size = await store.compact("ent_nope");
		expect(size).toBe(0);
	});

	it("appendAndMaybeCompact compacts when tail exceeds threshold", async () => {
		// Pick a threshold that fits one small update + header but trips on the
		// second. Header is 12 B; one short-text update is ~25 B; 60 B is in
		// between the first append and the second.
		const tinyStore = new YDocStore(vaultDir, { compactThresholdBytes: 60 });
		const writer = new Y.Doc();
		const u1 = captureUpdate(writer, () => writer.getText("t").insert(0, "first"));
		const r1 = await tinyStore.appendAndMaybeCompact("ent_thresh", u1);
		expect(r1.compacted).toBe(false);
		const u2 = captureUpdate(writer, () => writer.getText("t").insert(5, " second"));
		const r2 = await tinyStore.appendAndMaybeCompact("ent_thresh", u2);
		expect(r2.compacted).toBe(true);
		const result = await tinyStore.load("ent_thresh");
		expect(result.tailEntries).toBe(0);
		expect(result.doc.getText("t").toString()).toBe("first second");
	});

	it("writeSnapshot atomically replaces the file with a fresh snapshot", async () => {
		const writer = new Y.Doc();
		writer.getText("t").insert(0, "alpha");
		const snapshot = Y.encodeStateAsUpdate(writer);
		await store.writeSnapshot("ent_snap", snapshot);
		const result = await store.load("ent_snap");
		expect(result.tailEntries).toBe(0);
		expect(result.doc.getText("t").toString()).toBe("alpha");
	});

	it("rejects a file without the YDOC magic", async () => {
		const path = store.pathFor("ent_bad");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(vaultDir, "data", "docs", "ent"), { recursive: true });
		await writeFile(path, Buffer.from("XXXXxxxxxxxx"));
		await expect(store.load("ent_bad")).rejects.toThrow(/bad magic/);
	});

	it("rejects an unknown format version", async () => {
		const path = store.pathFor("ent_v99");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(vaultDir, "data", "docs", "ent"), { recursive: true });
		const buf = Buffer.alloc(12);
		buf.write("YDOC", 0);
		buf.writeUInt32LE(99, 4);
		buf.writeUInt32LE(0, 8);
		await writeFile(path, buf);
		await expect(store.load("ent_v99")).rejects.toThrow(/format version 99/);
	});

	it("skips a tail entry with a wrong CRC and reports truncatedTail=true", async () => {
		const writer = new Y.Doc();
		const u = captureUpdate(writer, () => writer.getText("t").insert(0, "ok"));
		await store.appendUpdate("ent_crc", u);

		// Corrupt the CRC of the single tail entry: bytes [HEADER_BYTES + 4 + updateLen ..]
		const path = store.pathFor("ent_crc");
		const raw = await readFile(path);
		// HEADER (12) + tail-entry length prefix (4) + update bytes (u.length) → CRC starts here
		const crcOffset = 12 + 4 + u.length;
		raw[crcOffset] = (raw[crcOffset] ?? 0) ^ 0xff;
		await writeFile(path, raw);

		const result = await store.load("ent_crc");
		expect(result.tailEntries).toBe(0);
		expect(result.truncatedTail).toBe(true);
	});

	it("skips a truncated final entry without throwing", async () => {
		const writer = new Y.Doc();
		const u = captureUpdate(writer, () => writer.getText("t").insert(0, "hi"));
		await store.appendUpdate("ent_trunc", u);
		const path = store.pathFor("ent_trunc");
		const raw = await readFile(path);
		// Drop the trailing 3 bytes of the CRC
		await writeFile(path, raw.subarray(0, raw.length - 3));
		const result = await store.load("ent_trunc");
		expect(result.tailEntries).toBe(0);
		expect(result.truncatedTail).toBe(true);
	});

	it("default compact threshold matches docs/18 (256 KiB)", () => {
		expect(DEFAULT_COMPACT_THRESHOLD).toBe(256 * 1024);
	});

	it("preserves Yjs CRDT semantics — concurrent updates from two replicas converge after load", async () => {
		// Two replicas mutate the same logical doc; their updates round-trip
		// through this store + load and produce the same final state.
		const a = new Y.Doc();
		const b = new Y.Doc();

		const ua1 = captureUpdate(a, () => a.getText("body").insert(0, "Hello"));
		Y.applyUpdate(b, ua1);
		const ub1 = captureUpdate(b, () => b.getText("body").insert(5, " from B"));
		await store.appendUpdate("ent_conv", ua1);
		await store.appendUpdate("ent_conv", ub1);

		const result = await store.load("ent_conv");
		expect(result.doc.getText("body").toString()).toBe("Hello from B");
	});
});

/**
 * F-486 — a persisted update that never arrived leaves every struct that
 * depends on it permanently unintegratable. The file is byte-perfect (clean
 * CRCs, no truncation) and the doc simply reads as missing that content, so
 * the loss is invisible without an explicit probe. Reproduces the 7 Journal
 * days the 329 audit found rendering a blank body under a "5 words" counter.
 */
describe("YDocStore — a missing update is detectable, not silent", () => {
	let vaultDir: string;
	let store: YDocStore;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-ydoc-hole-"));
		store = new YDocStore(vaultDir);
	});

	afterEach(async () => {
		await rm(vaultDir, { recursive: true, force: true });
	});

	it("flags a doc whose tail skips an update its later structs depend on", async () => {
		const src = new Y.Doc();
		// The first update is the one the renderer shipped while the entity row
		// did not exist yet: the canonical side rejected it and it was dropped,
		// so it is deliberately never appended.
		captureUpdate(src, () => src.getText("t").insert(0, "hello"));
		const second = captureUpdate(src, () => src.getText("t").insert(5, " world"));
		await store.appendUpdate("ent_hole", second);

		const result = await store.load("ent_hole");
		expect(result.truncatedTail).toBe(false); // the bytes on disk are fine
		expect(result.pendingStructs).toBe(true); // …but the doc is incomplete
		expect(result.doc.getText("t").toString()).toBe("");
	});

	it("does not flag a complete doc", async () => {
		const src = new Y.Doc();
		const first = captureUpdate(src, () => src.getText("t").insert(0, "hello"));
		const second = captureUpdate(src, () => src.getText("t").insert(5, " world"));
		await store.appendUpdate("ent_whole", first);
		await store.appendUpdate("ent_whole", second);

		const result = await store.load("ent_whole");
		expect(result.pendingStructs).toBe(false);
		expect(result.doc.getText("t").toString()).toBe("hello world");
	});
});
