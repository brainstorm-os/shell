#!/usr/bin/env node
/**
 * Generates the runtime app icon set from a source PNG.
 *
 * macOS app icons follow Apple's HIG template: the icon-body occupies ~80% of
 * the canvas with transparent margin on each side. This leaves room for the
 * subtle shadow / specular that macOS adds when rendering, and ensures the
 * icon-shape's rounded corners don't get clipped at the canvas edge.
 *
 * Inputs: (source artwork, square, ideally 1024×1024)
 * Outputs:
 *   packages/shell/art/icon.png                 512×512 RGBA, used by app.dock.setIcon()
 *   packages/shell/art/icon@2x.png              1024×1024 RGBA retina variant
 *   packages/shell/art/icon.iconset/...         All macOS iconset sizes (per Apple HIG)
 *   packages/shell/art/icon.icns                Compiled iconset (for production .app bundle)
 *   packages/shell/art/icon-bleed.png           512×512 full-bleed (NO Apple margin),
 *   packages/shell/art/icon-bleed@2x.png        1024×1024  — for in-app brand display
 *                                               where it sits in a squircle tile next to
 *                                               full-bleed app icons and must match them.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileP = promisify(execFile);

const ROOT = new URL("..", import.meta.url).pathname;
// The design docs live in the sibling harness repo (../harness/docs).
const SOURCE = [
	join(ROOT, "docs/art/icon/icon10.png"),
	join(ROOT, "../harness/docs/art/icon/icon10.png"),
	join(ROOT, "../docs/art/icon/icon10.png"),
].find((p) => existsSync(p));
const ART_DIR = join(ROOT, "packages/shell/art");
const ICONSET_DIR = join(ART_DIR, "icon.iconset");

// Per Apple's macOS app-icon template: the icon body should occupy ~80.5% of
// the canvas with transparent margin around it. (1024×1024 canvas → 824×824
// icon body; 512×512 canvas → 412×412 icon body.)
const ICON_BODY_RATIO = 824 / 1024;

// Below ~48px the glossy squircle collapses into a dark blob and the bolt
// becomes an unreadable speck (the tray symptom). Small sizes drop the
// container and render a clean bolt glyph on transparency — Apple's HIG
// explicitly recommends simplifying the mark at small sizes.
// Geometry mirrors (the single source of the artwork).
const GLYPH_SMALL_SIZE_CEIL = 64;
const BOLT_PATH = "M 600 215 L 348 555 L 488 555 L 424 808 L 676 468 L 536 468 Z";
// Bolt bbox ≈ x[348,676] y[215,808], centred on (512, 511). With no squircle
// to fill, scale it up to occupy ~87% of the canvas so it still reads at 16px.
const GLYPH_SCALE = 1.5;

// A clean gradient bolt — no glow, no shine, no stroke. Just the brand glyph.
function flatGlyphSvg() {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="boltGrad" x1="0.2" y1="0.05" x2="0.85" y2="0.95">
      <stop offset="0%" stop-color="#fda4af"/>
      <stop offset="40%" stop-color="#fb7185"/>
      <stop offset="75%" stop-color="#f43f5e"/>
      <stop offset="100%" stop-color="#e11d48"/>
    </linearGradient>
  </defs>
  <g transform="translate(512 512) scale(${GLYPH_SCALE}) translate(-512 -512)">
    <path d="${BOLT_PATH}" fill="url(#boltGrad)"/>
  </g>
</svg>`;
}

// macOS menu-bar template: the system tints the icon from its alpha channel
// only, so this is a flat solid silhouette — no gradient, no glow, no shine.
// That is what turns the menu-bar mark from a black blob into a crisp bolt.
function templateGlyphSvg() {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <g transform="translate(512 512) scale(${GLYPH_SCALE}) translate(-512 -512)">
    <path d="${BOLT_PATH}" fill="#000000"/>
  </g>
</svg>`;
}

async function renderGlyph(canvas, outPath, { template = false } = {}) {
	const svg = template ? templateGlyphSvg() : flatGlyphSvg();
	await sharp(Buffer.from(svg))
		.resize(canvas, canvas, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
		.png({ compressionLevel: 9 })
		.toFile(outPath);
}

// Tray / menu-bar glyph. The bolt is intrinsically tall + narrow (~0.55 aspect),
// so a square canvas bakes in ~25% dead space on each side — the mark then reads
// as a small bolt floating in a wide frame. Apple's own menu-bar glyphs are
// content-cropped (non-square) and the system supplies consistent spacing, so we
// crop to the glyph's alpha bbox + a small uniform pad and size by height.
const TRAY_ALPHA_THRESHOLD = 30;
const TRAY_PAD_RATIO = 0.06;

async function renderTrayGlyph(height, outPath, { template = false } = {}) {
	const svg = template ? templateGlyphSvg() : flatGlyphSvg();
	const base = await sharp(Buffer.from(svg))
		.resize(1024, 1024, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
		.png()
		.toBuffer();

	const { data, info } = await sharp(base).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const { width: w, height: h, channels } = info;
	let minX = w;
	let minY = h;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (data[(y * w + x) * channels + 3] > TRAY_ALPHA_THRESHOLD) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}

	const pad = Math.round((maxY - minY + 1) * TRAY_PAD_RATIO);
	const left = Math.max(0, minX - pad);
	const top = Math.max(0, minY - pad);
	const extractW = Math.min(w - left, maxX - minX + 1 + pad * 2);
	const extractH = Math.min(h - top, maxY - minY + 1 + pad * 2);

	await sharp(base)
		.extract({ left, top, width: extractW, height: extractH })
		.resize({ height, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
		.png({ compressionLevel: 9 })
		.toFile(outPath);
}

const ICONSET_SIZES = [
	{ size: 16, name: "icon_16x16.png" },
	{ size: 32, name: "icon_16x16@2x.png" },
	{ size: 32, name: "icon_32x32.png" },
	{ size: 64, name: "icon_32x32@2x.png" },
	{ size: 128, name: "icon_128x128.png" },
	{ size: 256, name: "icon_128x128@2x.png" },
	{ size: 256, name: "icon_256x256.png" },
	{ size: 512, name: "icon_256x256@2x.png" },
	{ size: 512, name: "icon_512x512.png" },
	{ size: 1024, name: "icon_512x512@2x.png" },
];

async function renderSize(canvas, outPath) {
	const bodySize = Math.round(canvas * ICON_BODY_RATIO);
	const margin = Math.round((canvas - bodySize) / 2);

	const body = await sharp(SOURCE)
		.resize(bodySize, bodySize, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
		.png()
		.toBuffer();

	await sharp({
		create: {
			width: canvas,
			height: canvas,
			channels: 4,
			background: { r: 0, g: 0, b: 0, alpha: 0 },
		},
	})
		.composite([{ input: body, top: margin, left: margin }])
		.png({ compressionLevel: 9 })
		.toFile(outPath);
}

async function main() {
	await rm(ICONSET_DIR, { recursive: true, force: true });
	await mkdir(ICONSET_DIR, { recursive: true });
	await mkdir(ART_DIR, { recursive: true });

	console.log(`Source: ${SOURCE}`);
	console.log(`Icon body ratio: ${ICON_BODY_RATIO.toFixed(3)} (Apple HIG inset)`);

	// Runtime icon — 512×512 RGBA with transparent margin, fed to app.dock.setIcon().
	const iconPath = join(ART_DIR, "icon.png");
	await renderSize(512, iconPath);
	console.log(`Wrote ${iconPath}`);

	// Retina variant at native source resolution.
	const iconRetinaPath = join(ART_DIR, "icon@2x.png");
	await renderSize(1024, iconRetinaPath);
	console.log(`Wrote ${iconRetinaPath}`);

	// Full-bleed variants — the source artwork at full canvas with NO Apple
	// margin. The dashboard squircle tile (overflow:hidden + radius) supplies
	// the rounded corners, so this reads identically to a first-party app icon
	// when shown in-app (e.g. Settings → Security capability rows).
	for (const [canvas, file] of [
		[512, "icon-bleed.png"],
		[1024, "icon-bleed@2x.png"],
	]) {
		const out = join(ART_DIR, file);
		await sharp(SOURCE)
			.resize(canvas, canvas, { fit: "cover" })
			.png({ compressionLevel: 9 })
			.toFile(out);
		console.log(`Wrote ${out}`);
	}

	// macOS iconset. Large reps keep the glossy squircle (the brand); small
	// reps (≤64px → the 16/32 slots Finder & the menu use) switch to the
	// clean glyph-forward bolt so the mark stays legible.
	for (const { size, name } of ICONSET_SIZES) {
		const out = join(ICONSET_DIR, name);
		if (size <= GLYPH_SMALL_SIZE_CEIL) await renderGlyph(size, out);
		else await renderSize(size, out);
	}
	console.log(`Wrote ${ICONSET_SIZES.length} iconset entries to ${ICONSET_DIR}`);

	// Tray / menu-bar icons — always glyph-forward (they render at ~18px).
	// macOS uses an alpha-only template the system tints; Windows/Linux use the
	// gradient bolt. nativeImage.createFromPath auto-picks the @2x rep on HiDPI.
	for (const [size, file, opts] of [
		[18, "trayTemplate.png", { template: true }],
		[36, "trayTemplate@2x.png", { template: true }],
		[18, "tray.png", {}],
		[36, "tray@2x.png", {}],
	]) {
		const out = join(ART_DIR, file);
		await renderTrayGlyph(size, out, opts);
		console.log(`Wrote ${out}`);
	}

	// Compile to .icns via macOS iconutil (built-in).
	const icnsPath = join(ART_DIR, "icon.icns");
	await rm(icnsPath, { force: true });
	await execFileP("iconutil", ["-c", "icns", ICONSET_DIR, "-o", icnsPath]);
	console.log(`Wrote ${icnsPath}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
