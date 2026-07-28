#![deny(clippy::all)]

//! Native image addon for Brainstorm — thumbnail derivation for the eager
//! asset tier (plan Asset-B4b).
//!
//! One job: decode an image, downscale it to a bounded long edge, and
//! re-encode it small (JPEG for opaque sources, PNG when alpha must survive).
//! Deliberately its OWN crate: the crypto addon (`packages/native`) must never
//! link format decoders (parser attack surface stays out of the
//! security-critical binary), and the embed addon (`packages/native-embed`)
//! is release-only (ONNX Runtime is too heavy for dev/CI builds) while
//! thumbnail derivation sits on the asset bind path and must exist — and be
//! testable — everywhere.
//!
//! Decoding runs on the libuv threadpool (`AsyncTask`), never the main
//! thread. Decode limits are pinned so a corrupt/hostile source cannot OOM
//! the process; on the owner device the input is the user's own file, but the
//! same fail-soft contract (an error here never fails the bind) is enforced
//! by the TS caller.

use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageFormat, ImageReader, Limits};
use napi::bindgen_prelude::{AsyncTask, Buffer, Env, Error, Result, Status, Task};
use napi_derive::napi;

/// Largest source edge the decoder will accept. Beyond this the decode is
/// refused (no thumbnail — fail-soft upstream), bounding the decode
/// allocation at ~1.5 GiB RGBA worst case before `MAX_DECODE_ALLOC` cuts in.
const MAX_SOURCE_EDGE: u32 = 16_384;

/// Hard cap on decoder allocations (bytes) — a decompression bomb fails the
/// decode instead of the process.
const MAX_DECODE_ALLOC: u64 = 512 * 1024 * 1024;

fn generic(msg: impl Into<String>) -> Error {
	Error::new(Status::GenericFailure, msg.into())
}

#[napi(object)]
pub struct ThumbnailResult {
	pub bytes: Buffer,
	/// `image/jpeg` (opaque source) or `image/png` (alpha preserved).
	pub mime: String,
	pub width: u32,
	pub height: u32,
	pub source_width: u32,
	pub source_height: u32,
}

pub struct ThumbnailOutput {
	bytes: Vec<u8>,
	mime: &'static str,
	width: u32,
	height: u32,
	source_width: u32,
	source_height: u32,
}

pub struct ThumbnailTask {
	// Copied out of the JS Buffer at call time so the task owns plain Send data.
	source: Vec<u8>,
	max_edge: u32,
	jpeg_quality: u8,
}

impl Task for ThumbnailTask {
	type Output = ThumbnailOutput;
	type JsValue = ThumbnailResult;

	fn compute(&mut self) -> Result<Self::Output> {
		let mut reader = ImageReader::new(Cursor::new(&self.source))
			.with_guessed_format()
			.map_err(|e| generic(format!("thumbnail: format sniff failed: {e}")))?;
		if reader.format().is_none() {
			return Err(generic("thumbnail: unrecognised image format"));
		}
		let mut limits = Limits::default();
		limits.max_image_width = Some(MAX_SOURCE_EDGE);
		limits.max_image_height = Some(MAX_SOURCE_EDGE);
		limits.max_alloc = Some(MAX_DECODE_ALLOC);
		reader.limits(limits);
		let img = reader
			.decode()
			.map_err(|e| generic(format!("thumbnail: decode failed: {e}")))?;
		let (source_width, source_height) = (img.width(), img.height());
		let thumb = if source_width.max(source_height) > self.max_edge {
			// `thumbnail` = fast integer downsampling; ample quality for a
			// preview-size derivative and much cheaper than Lanczos.
			img.thumbnail(self.max_edge, self.max_edge)
		} else {
			img
		};
		let (width, height) = (thumb.width(), thumb.height());
		let mut out = Vec::new();
		let mime = if has_transparency(&thumb) {
			thumb
				.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
				.map_err(|e| generic(format!("thumbnail: png encode failed: {e}")))?;
			"image/png"
		} else {
			let rgb = DynamicImage::from(thumb.to_rgb8());
			let mut cursor = Cursor::new(&mut out);
			let encoder = JpegEncoder::new_with_quality(&mut cursor, self.jpeg_quality);
			rgb.write_with_encoder(encoder)
				.map_err(|e| generic(format!("thumbnail: jpeg encode failed: {e}")))?;
			"image/jpeg"
		};
		Ok(ThumbnailOutput {
			bytes: out,
			mime,
			width,
			height,
			source_width,
			source_height,
		})
	}

	fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
		Ok(ThumbnailResult {
			bytes: output.bytes.into(),
			mime: output.mime.to_string(),
			width: output.width,
			height: output.height,
			source_width: output.source_width,
			source_height: output.source_height,
		})
	}
}

/// Whether any pixel is actually non-opaque. An alpha CHANNEL alone (every
/// PNG with color type RGBA) must not force the bulkier PNG encode when the
/// image is fully opaque — scan the (≤ max_edge²) thumbnail, not the source.
fn has_transparency(img: &DynamicImage) -> bool {
	if !img.color().has_alpha() {
		return false;
	}
	img.to_rgba8().pixels().any(|p| p.0[3] != u8::MAX)
}

/// Derive a bounded thumbnail from an encoded image. Rejects (throws) on an
/// undecodable/oversized source — the caller treats any rejection as "no
/// thumbnail" (fail-soft). Policy (which assets get thumbnails, whether the
/// result is worth keeping) lives in the TS caller; this is a pure transform.
#[napi(ts_return_type = "Promise<ThumbnailResult>")]
pub fn image_thumbnail(bytes: Buffer, max_edge: u32, jpeg_quality: u32) -> Result<AsyncTask<ThumbnailTask>> {
	if max_edge == 0 || max_edge > MAX_SOURCE_EDGE {
		return Err(generic(format!("thumbnail: maxEdge {max_edge} out of range")));
	}
	if !(1..=100).contains(&jpeg_quality) {
		return Err(generic(format!("thumbnail: jpegQuality {jpeg_quality} out of range")));
	}
	Ok(AsyncTask::new(ThumbnailTask {
		source: bytes.to_vec(),
		max_edge,
		jpeg_quality: jpeg_quality as u8,
	}))
}
