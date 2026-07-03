import { describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIM } from "./embedder";
import { type EmbedNative, FastembedEmbedder, makeEmbedderFromNative } from "./local-embedder";

/** A fake native addon: returns deterministic flat vectors (`fill` per text) so
 *  reshaping + dim assertions are checkable without the real ONNX model. */
function fakeNative(overrides: Partial<EmbedNative> = {}): EmbedNative {
	return {
		embedderInit: vi.fn(async () => undefined),
		embedderReady: vi.fn(() => true),
		embedDim: vi.fn(() => EMBEDDING_DIM),
		embedBatch: vi.fn(async (texts: string[]) => {
			const flat = new Float32Array(texts.length * EMBEDDING_DIM);
			for (let i = 0; i < texts.length; i += 1)
				flat.fill(i + 1, i * EMBEDDING_DIM, (i + 1) * EMBEDDING_DIM);
			return flat;
		}),
		...overrides,
	};
}

describe("FastembedEmbedder", () => {
	it("reports name + pinned dim", () => {
		const e = new FastembedEmbedder(fakeNative(), "/cache");
		expect(e.name).toBe("bge-small-en-v1.5");
		expect(e.dim).toBe(EMBEDDING_DIM);
	});

	it("embed returns a single dim-length vector and inits once", async () => {
		const native = fakeNative();
		const e = new FastembedEmbedder(native, "/cache");
		const v1 = await e.embed("hello");
		const v2 = await e.embed("world");
		expect(v1.length).toBe(EMBEDDING_DIM);
		expect(v2.length).toBe(EMBEDDING_DIM);
		// Single-flight init: embedderInit called exactly once across embeds.
		expect(native.embedderInit).toHaveBeenCalledTimes(1);
		expect(native.embedderInit).toHaveBeenCalledWith("/cache");
	});

	it("embed rejects on a dimension mismatch (fail-closed)", async () => {
		const native = fakeNative({
			embedBatch: vi.fn(async () => new Float32Array(EMBEDDING_DIM - 1)),
		});
		const e = new FastembedEmbedder(native, "/cache");
		await expect(e.embed("x")).rejects.toThrow(/expected 384 dims/);
	});

	it("embedMany reshapes a flat buffer into per-text views", async () => {
		const e = new FastembedEmbedder(fakeNative(), "/cache");
		const vecs = await e.embedMany(["a", "b", "c"]);
		expect(vecs).toHaveLength(3);
		expect(vecs[0]?.length).toBe(EMBEDDING_DIM);
		// Fake fills text i with (i+1); check the views map to the right rows.
		expect(vecs[0]?.[0]).toBe(1);
		expect(vecs[1]?.[0]).toBe(2);
		expect(vecs[2]?.[0]).toBe(3);
	});

	it("embedMany short-circuits on an empty batch (no native call)", async () => {
		const native = fakeNative();
		const e = new FastembedEmbedder(native, "/cache");
		expect(await e.embedMany([])).toEqual([]);
		expect(native.embedBatch).not.toHaveBeenCalled();
	});

	it("a failed init is not latched — the next embed retries", async () => {
		let calls = 0;
		const native = fakeNative({
			embedderInit: vi.fn(async () => {
				calls += 1;
				if (calls === 1) throw new Error("offline");
				return undefined;
			}),
		});
		const e = new FastembedEmbedder(native, "/cache");
		await expect(e.embed("x")).rejects.toThrow(/offline/);
		// Second attempt re-runs init (not stuck on the rejected promise).
		const v = await e.embed("x");
		expect(v.length).toBe(EMBEDDING_DIM);
		expect(calls).toBe(2);
	});
});

describe("makeEmbedderFromNative — graceful degrade", () => {
	it("returns an embedder for a well-formed native module", () => {
		expect(makeEmbedderFromNative(fakeNative(), "/cache")).toBeInstanceOf(FastembedEmbedder);
	});

	it("returns null when required exports are missing", () => {
		expect(makeEmbedderFromNative({}, "/cache")).toBeNull();
		expect(makeEmbedderFromNative({ embedBatch: vi.fn() }, "/cache")).toBeNull();
	});

	it("returns null on a model/store dimension mismatch", () => {
		const native = fakeNative({ embedDim: vi.fn(() => 512) });
		expect(makeEmbedderFromNative(native, "/cache")).toBeNull();
	});
});
