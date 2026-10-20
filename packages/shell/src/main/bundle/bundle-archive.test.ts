import { describe, expect, it } from "vitest";
import { packBundle, packBundleAsync, preferredCompression, unpackBundle } from "./bundle-archive";
import { BundleCompression } from "./bundle-format";
import { packTar, unpackTar } from "./bundle-tar";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("bundle-tar", () => {
	it("round-trips files byte-faithfully", () => {
		const entries = [
			{ path: "manifest.json", data: enc('{"v":1}') },
			{ path: "entities/brainstorm/Note/v1/abc.json", data: enc('{"id":"abc"}') },
			{ path: "ydoc/abc.bin", data: new Uint8Array([0, 1, 2, 255, 254]) },
		];
		const out = unpackTar(packTar(entries));
		expect(out).toHaveLength(3);
		expect(out.map((e) => e.path).sort()).toEqual(entries.map((e) => e.path).sort());
		const ydoc = out.find((e) => e.path === "ydoc/abc.bin");
		expect(ydoc?.data).toEqual(new Uint8Array([0, 1, 2, 255, 254]));
	});

	it("is deterministic for identical input", () => {
		const entries = [
			{ path: "b.json", data: enc("b") },
			{ path: "a.json", data: enc("a") },
		];
		expect(Buffer.from(packTar(entries))).toEqual(Buffer.from(packTar(entries)));
	});

	it("supports paths longer than 100 bytes via the GNU long-name extension", () => {
		const longType = `brainstorm/${"Very".repeat(20)}LongCustomType/v1`;
		const path = `entities/${longType}/550e8400-e29b-41d4-a716-446655440000.json`;
		expect(Buffer.byteLength(path)).toBeGreaterThan(100);
		const out = unpackTar(packTar([{ path, data: enc("payload") }]));
		expect(out).toHaveLength(1);
		expect(out[0]?.path).toBe(path);
		expect(dec(out[0]?.data ?? new Uint8Array())).toBe("payload");
	});

	it("rejects path-traversal and absolute entries on read", () => {
		// Hand-build a tar whose header name escapes the extraction root.
		const evil = packTar([{ path: "ok.json", data: enc("x") }]);
		const tampered = Buffer.from(evil);
		tampered.write("../escape", 0, 100, "utf8");
		// recompute the checksum so the header isn't rejected for the wrong reason
		tampered.write("        ", 148, 8, "ascii");
		let sum = 0;
		for (let i = 0; i < 512; i++) sum += tampered[i] ?? 0;
		tampered.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
		expect(() => unpackTar(tampered)).toThrow(/path-traversal/);
	});
});

describe("bundle-archive", () => {
	const files = new Map<string, Uint8Array>([
		["manifest.json", enc('{"bundleFormatVersion":"1.0.0"}')],
		["links.jsonl", enc('{"id":"l1"}\n')],
		["blobs/deadbeef", new Uint8Array([1, 2, 3, 4, 5])],
	]);

	it("round-trips through the default compressor", () => {
		const out = unpackBundle(packBundle(files));
		expect([...out.keys()].sort()).toEqual([...files.keys()].sort());
		expect(out.get("blobs/deadbeef")).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
	});

	it("is deterministic and reports its compression in the header", () => {
		const a = packBundle(files);
		const b = packBundle(files);
		expect(Buffer.from(a)).toEqual(Buffer.from(b));
		expect(Buffer.from(a).subarray(0, 4).toString("ascii")).toBe("BSB1");
	});

	for (const algo of [BundleCompression.None, BundleCompression.Gzip]) {
		it(`round-trips under ${algo} compression`, () => {
			const out = unpackBundle(packBundle(files, algo));
			expect(out.get("manifest.json")).toEqual(files.get("manifest.json"));
		});
	}

	it("round-trips under the preferred (runtime-best) compressor", () => {
		const out = unpackBundle(packBundle(files, preferredCompression()));
		expect(out.get("links.jsonl")).toEqual(files.get("links.jsonl"));
	});

	it("rejects a buffer with a bad magic", () => {
		expect(() => unpackBundle(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/bad magic/);
	});
});

describe("packBundleAsync (IE-14)", () => {
	const files = new Map([
		["manifest.json", enc('{"v":1}')],
		["ydoc/a.bin", new Uint8Array(512 * 1024).map((_, i) => (i * 31) % 251)],
	]);

	it("writes the exact bytes the sync packer does, for every algorithm", async () => {
		for (const algo of [BundleCompression.None, BundleCompression.Gzip, preferredCompression()]) {
			expect(Buffer.from(await packBundleAsync(files, algo))).toEqual(
				Buffer.from(packBundle(files, algo)),
			);
		}
		expect(
			dec(unpackBundle(await packBundleAsync(files)).get("manifest.json") ?? new Uint8Array()),
		).toBe('{"v":1}');
	});

	it("compresses off the main thread: the event loop keeps turning meanwhile", async () => {
		let turned = false;
		setImmediate(() => {
			turned = true;
		});
		const pending = packBundleAsync(files, BundleCompression.Gzip);
		await pending;
		expect(turned).toBe(true);
	});
});
