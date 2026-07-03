import { describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIM } from "./embedder";
import { EmbedderPhase, type SemanticModelStatus } from "./embedder-status";
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
		expect(native.embedderInit).toHaveBeenCalledWith("/cache", expect.any(Function));
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

describe("FastembedEmbedder — download status (11.3 progress UX)", () => {
	it("emits Downloading → Ready across a successful first-run init", async () => {
		const statuses: SemanticModelStatus[] = [];
		const e = new FastembedEmbedder(fakeNative(), "/cache", (s) => statuses.push(s));
		await e.embed("hello");
		expect(statuses.map((s) => s.phase)).toEqual([EmbedderPhase.Downloading, EmbedderPhase.Ready]);
		expect(statuses.at(-1)?.percent).toBe(100);
	});

	it("folds native per-file progress ticks into the status", async () => {
		const native = fakeNative({
			embedderInit: vi.fn(async (_dir: string, onProgress?: (p: unknown) => void) => {
				onProgress?.({ file: "model.onnx", fileIndex: 0, fileCount: 5, downloaded: 25, total: 100 });
				onProgress?.({ file: "model.onnx", fileIndex: 0, fileCount: 5, downloaded: 75, total: 100 });
			}),
		});
		const statuses: SemanticModelStatus[] = [];
		const e = new FastembedEmbedder(native, "/cache", (s) => statuses.push(s));
		await e.embed("hello");
		// started → 25% → 75% → ready
		expect(statuses.map((s) => s.percent)).toEqual([null, 25, 75, 100]);
		expect(statuses[1]?.file).toBe("model.onnx");
		expect(statuses[1]?.fileNumber).toBe(1);
	});

	it("emits Failed with the error message on a failed init, then retries clean", async () => {
		let calls = 0;
		const native = fakeNative({
			embedderInit: vi.fn(async () => {
				calls += 1;
				if (calls === 1) throw new Error("offline");
			}),
		});
		const statuses: SemanticModelStatus[] = [];
		const e = new FastembedEmbedder(native, "/cache", (s) => statuses.push(s));
		await expect(e.embed("x")).rejects.toThrow(/offline/);
		expect(statuses.at(-1)?.phase).toBe(EmbedderPhase.Failed);
		expect(statuses.at(-1)?.error).toBe("offline");
		await e.embed("x");
		expect(statuses.at(-1)?.phase).toBe(EmbedderPhase.Ready);
	});

	it("works without a status sink (optional)", async () => {
		const e = new FastembedEmbedder(fakeNative(), "/cache");
		await expect(e.embed("x")).resolves.toHaveLength(EMBEDDING_DIM);
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
