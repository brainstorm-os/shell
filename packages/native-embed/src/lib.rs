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

use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use fastembed::{
	InitOptionsUserDefined, Pooling, TextEmbedding, TokenizerFiles, UserDefinedEmbeddingModel,
};
use napi::bindgen_prelude::{AsyncTask, Env, Error, Float32Array, Result, Status, Task, Unknown};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use sha2::{Digest, Sha256};

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

// ── First-run download progress (plan 11.3 progress UX) ─────────────────────

/// A per-file byte-progress tick emitted to JS while the model weights download.
/// `total` is 0 when the server sent no `Content-Length`. Byte counts are `f64`
/// (JS numbers) — the largest file is ~130 MB, far inside f64's exact-int range.
#[napi(object)]
pub struct DownloadProgress {
	pub file: String,
	pub file_index: u32,
	pub file_count: u32,
	pub downloaded: f64,
	pub total: f64,
}

/// The JS `(progress) => void` callback, invoked from the download thread.
/// `CalleeHandled = false` (Fatal strategy) so JS receives just the value — the
/// shape the shell seam's `onProgress(progress)` expects.
type ProgressFn = ThreadsafeFunction<DownloadProgress, Unknown<'static>, DownloadProgress, Status, false>;

/// Coalesce byte ticks to ~1 MB steps so a 130 MB download emits ~130 progress
/// events, not thousands — smooth enough for a bar without spamming the JS loop.
const PROGRESS_STEP_BYTES: u64 = 1024 * 1024;

fn report(progress: &Option<ProgressFn>, tick: DownloadProgress) {
	if let Some(tsfn) = progress {
		tsfn.call(tick, ThreadsafeFunctionCallMode::NonBlocking);
	}
}

// ── Pinned model integrity (security review, 2026-07-03) ────────────────────
//
// fastembed's `try_new` downloads the model from HuggingFace over TLS and hands
// it straight to ONNX Runtime — no verification against a hash WE control, so a
// TLS-breaking position (corp MITM, CA compromise) or a compromised HF repo
// could substitute a malicious `model.onnx` that ORT then parses IN-PROCESS.
// Instead we fetch the exact files ourselves, verify each against a pinned
// SHA256 BEFORE ONNX Runtime ever sees the bytes (fail-closed on any mismatch),
// and only then build the model via `try_new_from_user_defined`. The pins are
// the `Xenova/bge-small-en-v1.5` files at the revision below (their real hashes,
// computed from the known-good download); changing the model means re-pinning.

/// Immutable HF revision the pins below were computed against — resolve URLs
/// point at this commit so the served bytes can't shift under us.
const HF_MODEL_BASE: &str =
	"https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/ea104dacec62c0de699686887e3f920caeb4f3e3";

/// A model file: its cache filename, its path within the HF repo, and the
/// SHA256 the downloaded/cached bytes MUST match.
struct PinnedFile {
	name: &'static str,
	repo_path: &'static str,
	sha256: &'static str,
}

const PINNED_FILES: &[PinnedFile] = &[
	PinnedFile {
		name: "model.onnx",
		repo_path: "onnx/model.onnx",
		sha256: "828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35",
	},
	PinnedFile {
		name: "tokenizer.json",
		repo_path: "tokenizer.json",
		sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
	},
	PinnedFile {
		name: "config.json",
		repo_path: "config.json",
		sha256: "fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350",
	},
	PinnedFile {
		name: "special_tokens_map.json",
		repo_path: "special_tokens_map.json",
		sha256: "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3",
	},
	PinnedFile {
		name: "tokenizer_config.json",
		repo_path: "tokenizer_config.json",
		sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
	},
];

/// Hard ceiling on any single downloaded file, so a hostile/broken server can't
/// stream unbounded bytes to OOM the host before we get to hash-check. The model
/// is ~130 MB; 512 MB is generous headroom.
const MAX_MODEL_FILE_BYTES: u64 = 512 * 1024 * 1024;

fn sha256_hex(bytes: &[u8]) -> String {
	let mut hasher = Sha256::new();
	hasher.update(bytes);
	hasher
		.finalize()
		.iter()
		.map(|b| format!("{b:02x}"))
		.collect()
}

/// Load one pinned file: reuse the on-disk cache when its bytes already match
/// the pin; otherwise fetch from the pinned HF URL, verify the SHA256, and cache
/// it. Returns an error (never the bytes) on any hash mismatch — a tampered
/// download, a MITM, or a poisoned repo all fail closed here, before the bytes
/// reach ONNX Runtime or the tokenizer.
fn load_pinned(
	cache_dir: &Path,
	file: &PinnedFile,
	file_index: u32,
	file_count: u32,
	progress: &Option<ProgressFn>,
) -> Result<Vec<u8>> {
	let path = cache_dir.join(file.name);
	if let Ok(bytes) = fs::read(&path) {
		if sha256_hex(&bytes) == file.sha256 {
			return Ok(bytes);
		}
		// Present but wrong (corrupt / tampered on disk) — re-fetch below.
	}

	let url = format!("{HF_MODEL_BASE}/{}", file.repo_path);
	let response = ureq::get(&url)
		.call()
		.map_err(|e| generic(format!("embedder model fetch {}: {e}", file.name)))?;
	let total: u64 = response
		.header("Content-Length")
		.and_then(|s| s.parse().ok())
		.unwrap_or(0);
	let emit = |downloaded: u64| {
		report(
			progress,
			DownloadProgress {
				file: file.name.to_string(),
				file_index,
				file_count,
				downloaded: downloaded as f64,
				total: total as f64,
			},
		);
	};
	// Emit a 0-byte tick up front so the UI shows the file immediately, before
	// the first megabyte lands (the model.onnx fetch dominates the wall-clock).
	emit(0);

	// Stream in chunks (rather than `read_to_end`) so progress can be reported
	// as bytes arrive. Still bounded by `MAX_MODEL_FILE_BYTES` (the `.take`) and
	// SHA256-verified below before the bytes ever reach ONNX Runtime.
	let mut reader = response.into_reader().take(MAX_MODEL_FILE_BYTES + 1);
	let mut bytes = Vec::new();
	let mut buf = [0u8; 64 * 1024];
	let mut last_reported = 0u64;
	loop {
		let n = reader
			.read(&mut buf)
			.map_err(|e| generic(format!("embedder model read {}: {e}", file.name)))?;
		if n == 0 {
			break;
		}
		bytes.extend_from_slice(&buf[..n]);
		if bytes.len() as u64 > MAX_MODEL_FILE_BYTES {
			return Err(generic(format!(
				"embedder model {} exceeds {MAX_MODEL_FILE_BYTES} bytes — refusing",
				file.name
			)));
		}
		let downloaded = bytes.len() as u64;
		if downloaded - last_reported >= PROGRESS_STEP_BYTES {
			last_reported = downloaded;
			emit(downloaded);
		}
	}
	emit(bytes.len() as u64);

	let got = sha256_hex(&bytes);
	if got != file.sha256 {
		return Err(generic(format!(
			"embedder model {} SHA256 mismatch (expected {}, got {got}) — refusing to load a tampered model",
			file.name, file.sha256
		)));
	}

	// Best-effort cache; a write failure just means we re-verify+fetch next time.
	if fs::create_dir_all(cache_dir).is_ok() {
		let _ = fs::write(&path, &bytes);
	}
	Ok(bytes)
}

fn pinned(name: &str) -> (u32, &'static PinnedFile) {
	PINNED_FILES
		.iter()
		.enumerate()
		.find(|(_, f)| f.name == name)
		.map(|(i, f)| (i as u32, f))
		.expect("pinned model file present")
}

/// Build the `bge-small-en-v1.5` model from integrity-verified files (see the
/// pinning note above), matching the built-in registry config (CLS pooling,
/// max_length 512) so embeddings are identical to fastembed's own path. Runs on
/// the libuv threadpool so the ~130 MB first-run download never blocks the JS
/// thread; subsequent runs load the verified files from `cache_dir`.
struct InitTask {
	cache_dir: String,
	progress: Option<ProgressFn>,
}

impl Task for InitTask {
	type Output = ();
	type JsValue = ();

	fn compute(&mut self) -> Result<()> {
		if MODEL.get().is_some() {
			return Ok(());
		}
		let dir = Path::new(&self.cache_dir).join("bge-small-en-v1.5");
		let count = PINNED_FILES.len() as u32;
		let load = |name: &str| -> Result<Vec<u8>> {
			let (index, file) = pinned(name);
			load_pinned(&dir, file, index, count, &self.progress)
		};
		let user_model = UserDefinedEmbeddingModel::new(
			load("model.onnx")?,
			TokenizerFiles {
				tokenizer_file: load("tokenizer.json")?,
				config_file: load("config.json")?,
				special_tokens_map_file: load("special_tokens_map.json")?,
				tokenizer_config_file: load("tokenizer_config.json")?,
			},
		)
		.with_pooling(Pooling::Cls);
		// `new()` defaults to CPU execution providers; pin max_length to the
		// built-in bge config so embeddings match fastembed's own path.
		let model = TextEmbedding::try_new_from_user_defined(
			user_model,
			InitOptionsUserDefined::new().with_max_length(512),
		)
		.map_err(|e| generic(format!("embedder init: {e}")))?;
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
/// first-run download is controllable + offline-reusable). `onProgress`
/// (optional) is called from the download thread with per-file byte progress so
/// the shell can render a first-run-download bar (plan 11.3). Resolves once the
/// model is ready to embed.
#[napi(ts_return_type = "Promise<void>")]
pub fn embedder_init(
	cache_dir: String,
	#[napi(
		ts_arg_type = "(progress: { file: string; fileIndex: number; fileCount: number; downloaded: number; total: number }) => void"
	)]
	on_progress: Option<ThreadsafeFunction<DownloadProgress, Unknown<'static>, DownloadProgress, Status, false>>,
) -> AsyncTask<InitTask> {
	AsyncTask::new(InitTask {
		cache_dir,
		progress: on_progress,
	})
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
