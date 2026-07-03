# @brainstorm/native-embed

Native NAPI-RS embedding addon for Brainstorm's **local semantic search** (plan
11.3). Wraps [`fastembed-rs`](https://github.com/Anush008/fastembed-rs) (ONNX
Runtime) to compute on-device text embeddings — `bge-small-en-v1.5`, 384-d,
English. Content never leaves the device (the only network is the one-time
model-weight download on first use).

## Why a separate crate from `@brainstorm/native`

ONNX Runtime is a large native dependency. Keeping it out of the
security-critical crypto crate (`@brainstorm/native`) means the crypto binary
stays small + cross-compiles cleanly, and this addon can be loaded lazily (only
when semantic search is enabled) and shipped/updated independently.

## Surface (`src/lib.rs`)

- `embedderInit(cacheDir): Promise<void>` — build/load the model, downloading
  weights into `cacheDir` on first run (idempotent, off the JS thread).
- `embedderReady(): boolean` — whether init has completed.
- `embedDim(): number` — the model's output dimension (384).
- `embedBatch(texts): Promise<Float32Array>` — flat row-major
  `texts.length * 384` embeddings.

The shell consumes these through `main/search/local-embedder.ts`
(`FastembedEmbedder implements TextEmbedder`), which degrades to lexical-only
search if this addon can't load.

## Model swaps

`EMBEDDING_DIM` (384) is pinned to the `sqlite-vec` table shape, so swapping to
another 384-d model (MiniLM, multilingual-e5-small) is a one-line change to the
`EmbeddingModel` variant in `src/lib.rs` — no vector-table migration.

## Building

`bun run build:native-embed` (debug) / `:release` from the repo root, or
`napi build --platform` here. Generated `index.js` / `index.d.ts` / `*.node`
are gitignored (built per-platform).

**Deferred (the packaging tail):** cross-platform CI prebuilds (6-target matrix,
mirroring the crypto crate's 13.1c pattern) and shipping the ONNX Runtime shared
library + the `.node` via electron-builder `extraResources`. Until then the
addon works in dev; a packaged build degrades to lexical-only.
