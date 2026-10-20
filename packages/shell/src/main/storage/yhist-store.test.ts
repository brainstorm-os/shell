import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { YHIST_HEADER_BYTES, YHistStore } from "./yhist-store";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("YHistStore", () => {
	let dir: string;
	let store: YHistStore;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bs-yhist-"));
		store = new YHistStore(dir);
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("appends frames and reads each back by its ref", async () => {
		const a = await store.append("ent_a", bytes("first"));
		const b = await store.append("ent_a", bytes("second body"));
		expect(a.offset).toBe(YHIST_HEADER_BYTES);
		expect(b.offset).toBeGreaterThan(a.offset);
		expect(text(await store.read("ent_a", a))).toBe("first");
		expect(text(await store.read("ent_a", b))).toBe("second body");
	});

	it("lives under data/history, sharded by id prefix, with the YHST magic", async () => {
		await store.append("ent_a", bytes("x"));
		const raw = await readFile(join(dir, "data", "history", "ent", "ent_a.yhist"));
		expect(raw.subarray(0, 4).toString("ascii")).toBe("YHST");
	});

	it("refuses a ref whose length does not match the stored frame", async () => {
		const a = await store.append("ent_a", bytes("first"));
		await expect(store.read("ent_a", { offset: a.offset, length: a.length + 1 })).rejects.toThrow(
			/length/,
		);
	});

	it("refuses a ref that does not land on a frame boundary", async () => {
		const a = await store.append("ent_a", bytes("abcdefghijklmnop"));
		await expect(store.read("ent_a", { offset: a.offset + 2, length: 3 })).rejects.toThrow();
		await expect(store.read("ent_a", { offset: 0, length: 3 })).rejects.toThrow(/offset/);
	});

	it("detects a corrupted frame by CRC", async () => {
		const a = await store.append("ent_a", bytes("intact"));
		const path = store.pathFor("ent_a");
		const raw = await readFile(path);
		raw[a.offset + 5] = (raw[a.offset + 5] ?? 0) ^ 0xff;
		await writeFile(path, raw);
		await expect(store.read("ent_a", a)).rejects.toThrow(/corrupt/);
	});

	it("keeps appending after a torn final frame (crash mid-append)", async () => {
		await store.append("ent_a", bytes("ok"));
		await appendFile(store.pathFor("ent_a"), Buffer.from([9, 0, 0, 0, 1, 2]));
		const next = await store.append("ent_a", bytes("after crash"));
		expect(text(await store.read("ent_a", next))).toBe("after crash");
	});

	it("rewrite keeps only the given frames and reports where they moved", async () => {
		const a = await store.append("ent_a", bytes("drop me"));
		const b = await store.append("ent_a", bytes("keep me"));
		const moved = await store.rewrite("ent_a", [b]);
		const nb = moved.get(b.offset);
		expect(nb?.offset).toBe(YHIST_HEADER_BYTES);
		expect(text(await store.read("ent_a", nb ?? b))).toBe("keep me");
		expect(moved.has(a.offset)).toBe(false);
	});

	it("rewrite with nothing to keep removes the file", async () => {
		await store.append("ent_a", bytes("x"));
		await store.rewrite("ent_a", []);
		expect(await store.listEntityIds()).toEqual([]);
	});

	it("serialises appends with rewrites on the same entity", async () => {
		const first = await store.append("ent_a", bytes("one"));
		const [, appended] = await Promise.all([
			store.rewrite("ent_a", [first]),
			store.append("ent_a", bytes("two")),
		]);
		expect(text(await store.read("ent_a", appended))).toBe("two");
	});

	it("rejects a path-traversing entity id", async () => {
		await expect(store.append("../../etc/passwd", bytes("x"))).rejects.toThrow();
		expect(() => store.pathFor("a/b")).toThrow();
	});
});
