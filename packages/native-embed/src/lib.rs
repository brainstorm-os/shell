#![deny(clippy::all)]

//! Native embedding addon for Brainstorm semantic search (plan 11.3).
//!
//! Wraps `fastembed-rs` (ONNX Runtime) behind two async NAPI calls. This crate
//! is deliberately SEPARATE from `packages/native` (the crypto addon): ONNX
//! Runtime is a large native dependency that must never link into the
//! security-critical crypto binary, and embeddings are optional + lazily loaded
//! (first-run model download), so they ship as their own `.node`.
//!
//! The model is `bge-small-en-v1.5` (384-d, English). The dimension matches the
//! shell's pinned `EMBEDDING_DIM` + the `sqlite-vec` table shape, so swapping to
//! another 384-d model (MiniLM, multilingual-e5-small) later needs no schema
//! change — only the `EmbeddingModel` variant here.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use napi::bindgen_prelude::{AsyncTask, Env, Error, Float32Array, Result, Status, Task};
use napi_derive::napi;

/// Output dimension of `bge-small-en-v1.5`. Pinned to the shell's
/// `EMBEDDING_DIM` and the `entity_vec` vec0 table width — a mismatch is a
/// fail-closed error, never a silent truncation.
const EMBED_DIM: usize = 384;

/// The one process-wide model. `OnceLock` gives a lazily-initialised singleton;
/// the inner `Mutex` serialises `embed` calls (the ORT session is `Send` but we
/// don't rely on it being `Sync`). Built once by `embedderInit`.
static MODEL: OnceLock<Mutex<TextEmbedding>> = OnceLock::new();

fn generic(msg: impl Into<String>) -> Error {
	Error::new(Status::GenericFailure, msg.into())
}

/// Build the `TextEmbedding` model, downloading its weights into `cache_dir` on
/// first run (subsequent runs load from disk). Runs on the libuv threadpool so
/// the ~130 MB first-run download never blocks the JS thread.
struct InitTask {
	cache_dir: String,
}

impl Task for InitTask {
	type Output = ();
	type JsValue = ();

	fn compute(&mut self) -> Result<()> {
		if MODEL.get().is_some() {
			return Ok(());
		}
		let opts = InitOptions::new(EmbeddingModel::BGESmallENV15)
			.with_cache_dir(PathBuf::from(&self.cache_dir))
			.with_show_download_progress(false);
		let model =
			TextEmbedding::try_new(opts).map_err(|e| generic(format!("embedder init: {e}")))?;
		// Ignore a lost race: whichever `set` wins, the model is equivalent, and
		// the loser is dropped here.
		let _ = MODEL.set(Mutex::new(model));
		Ok(())
	}

	fn resolve(&mut self, _env: Env, _output: ()) -> Result<()> {
		Ok(())
	}
}

/// Initialise the embedder (idempotent). `cacheDir` is where model weights are
/// downloaded + cached (the shell points this at its userData dir so the
/// first-run download is controllable + offline-reusable). Resolves once the
/// model is ready to embed.
#[napi(ts_return_type = "Promise<void>")]
pub fn embedder_init(cache_dir: String) -> AsyncTask<InitTask> {
	AsyncTask::new(InitTask { cache_dir })
}

/// Whether `embedderInit` has completed — a cheap synchronous probe the shell
/// uses to gate vector indexing (fail to lexical-only if the model isn't ready).
#[napi]
pub fn embedder_ready() -> bool {
	MODEL.get().is_some()
}

/// The embedding dimension. Exposed so the JS seam can assert it equals the
/// store's pinned `EMBEDDING_DIM` on first write (fail-closed).
#[napi]
pub fn embed_dim() -> u32 {
	EMBED_DIM as u32
}

/// Embed a batch of texts. Returns a FLAT `Float32Array` of length
/// `texts.len() * 384` (row-major); the JS side reshapes into per-text 384-d
/// vectors. Flattening avoids `Vec<Float32Array>` marshalling overhead on large
/// rebuilds. Runs on the libuv threadpool.
struct EmbedTask {
	texts: Vec<String>,
}

impl Task for EmbedTask {
	type Output = Vec<f32>;
	type JsValue = Float32Array;

	fn compute(&mut self) -> Result<Vec<f32>> {
		let cell = MODEL
			.get()
			.ok_or_else(|| generic("embedder not initialised (call embedderInit first)"))?;
		let model = cell.lock().map_err(|_| generic("embedder mutex poisoned"))?;
		let refs: Vec<&str> = self.texts.iter().map(String::as_str).collect();
		let embeddings = model.embed(refs, None).map_err(|e| generic(format!("embed: {e}")))?;
		let mut out = Vec::with_capacity(embeddings.len() * EMBED_DIM);
		for embedding in embeddings {
			if embedding.len() != EMBED_DIM {
				return Err(generic(format!(
					"unexpected embedding dim {} (expected {EMBED_DIM})",
					embedding.len()
				)));
			}
			out.extend_from_slice(&embedding);
		}
		Ok(out)
	}

	fn resolve(&mut self, _env: Env, output: Vec<f32>) -> Result<Float32Array> {
		Ok(Float32Array::new(output))
	}
}

/// Embed `texts` into a flat row-major `Float32Array` (`texts.len() * 384`).
#[napi(ts_return_type = "Promise<Float32Array>")]
pub fn embed_batch(texts: Vec<String>) -> AsyncTask<EmbedTask> {
	AsyncTask::new(EmbedTask { texts })
}
