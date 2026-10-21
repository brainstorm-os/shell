#!/usr/bin/env node
/**
 * 13.1a — local verification that `bun run package` produced a
 * well-formed packaged artefact.
 *
 * Checks the host-platform output for:
 *   - the asar bundle (proves electron-builder ran)
 *   - apps/<id>/dist/index.html for every FIRST_PARTY_APPS entry
 *     (proves extraResources fired)
 *   - apps/<id>/manifest.json for every FIRST_PARTY_APPS entry
 *   - at least one bundled `.node` (proves asarUnpack passed the
 *     native binary through)
 *
 * Run via `bun run package && node packages/shell/scripts/preview-package.mjs`.
 *
 * This is the dev-loop check. The 13.1c GitHub Actions matrix is the
 * real verification — running the script on macOS only proves the
 * darwin-arm64/x64 outputs; the Windows + Linux artefacts ship only
 * through CI.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHELL_ROOT = resolve(__dirname, "..");
const DIST_ROOT = join(SHELL_ROOT, "dist");

const FIRST_PARTY_DIRS = [
	"notes",
	"files",
	"database",
	"graph",
	"tasks",
	"calendar",
	"journal",
	"preview",
	"code-editor",
	"whiteboard",
	"bookmarks",
];

function fail(reason) {
	console.error(`[preview-package] FAIL: ${reason}`);
	process.exitCode = 1;
}

function ok(message) {
	console.log(`[preview-package] OK: ${message}`);
}

function info(message) {
	console.log(`[preview-package] ${message}`);
}

/**
 * Locate the per-platform artefact root inside `packages/shell/dist`.
 *
 * - macOS: `dist/<arch>/<ProductName>.app/Contents/Resources/`
 *   (and `dist/<arch>/<ProductName>.app/Contents/Resources/app.asar`)
 * - Linux AppImage / unpacked: `dist/linux-unpacked/resources/` or
 *   `dist/linux-arm64-unpacked/resources/`
 * - Windows: `dist/win-unpacked/resources/` or
 *   `dist/win-arm64-unpacked/resources/`
 *
 * Returns the first match found, or null if nothing's there.
 */
function findResourcesRoot() {
	if (!existsSync(DIST_ROOT)) return null;
	const entries = readdirSync(DIST_ROOT, { withFileTypes: true });

	// macOS — look for any `<arch>/<Product>.app/Contents/Resources`.
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const base = join(DIST_ROOT, entry.name);
		// Direct .app
		for (const sub of safeReaddir(base)) {
			if (sub.endsWith(".app")) {
				const resources = join(base, sub, "Contents", "Resources");
				if (existsSync(resources)) return { kind: "mac", root: resources, app: join(base, sub) };
			}
		}
		// Some layouts put the .app right under dist/ without an arch subfolder.
		if (entry.name.endsWith(".app")) {
			const resources = join(DIST_ROOT, entry.name, "Contents", "Resources");
			if (existsSync(resources)) {
				return { kind: "mac", root: resources, app: join(DIST_ROOT, entry.name) };
			}
		}
	}

	// Linux unpacked
	for (const candidate of ["linux-unpacked", "linux-arm64-unpacked"]) {
		const path = join(DIST_ROOT, candidate, "resources");
		if (existsSync(path)) return { kind: "linux", root: path, app: join(DIST_ROOT, candidate) };
	}

	// Windows unpacked
	for (const candidate of ["win-unpacked", "win-arm64-unpacked"]) {
		const path = join(DIST_ROOT, candidate, "resources");
		if (existsSync(path)) return { kind: "win", root: path, app: join(DIST_ROOT, candidate) };
	}

	return null;
}

function safeReaddir(path) {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}

function findFileRecursive(root, predicate, limit = 25) {
	const stack = [root];
	let visited = 0;
	while (stack.length > 0 && visited < 5000) {
		const current = stack.pop();
		visited += 1;
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const abs = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(abs);
			} else if (entry.isFile() && predicate(abs, entry.name)) {
				return abs;
			}
		}
		if (visited >= limit && limit > 0) {
			// Don't actually stop — just a heartbeat for large trees.
		}
	}
	return null;
}

function main() {
	info(`looking under ${DIST_ROOT}`);
	const found = findResourcesRoot();
	if (!found) {
		const here = process.platform;
		console.log(
			`[preview-package] SKIP: no packaged artefact under ${DIST_ROOT} for host ${here}. ` +
				`Run \`bun run package\` first (or \`bun run package:${here === "darwin" ? "mac" : here === "win32" ? "win" : "linux"}\`).`,
		);
		// SKIP is not a failure — the script is opportunistic on the dev loop.
		return;
	}
	info(`resources root: ${found.root} (kind=${found.kind})`);

	// asar bundle
	const asarPath = join(found.root, "app.asar");
	if (!existsSync(asarPath)) fail(`missing app.asar at ${asarPath}`);
	else ok(`app.asar present (${statSync(asarPath).size} bytes)`);

	// apps/* tree
	const appsRoot = join(found.root, "apps");
	if (!existsSync(appsRoot)) {
		fail(`missing apps/ extraResources at ${appsRoot}`);
	} else {
		for (const dir of FIRST_PARTY_DIRS) {
			const manifest = join(appsRoot, dir, "manifest.json");
			const indexHtml = join(appsRoot, dir, "dist", "index.html");
			if (!existsSync(manifest)) fail(`missing manifest for ${dir}: ${manifest}`);
			else ok(`apps/${dir}/manifest.json`);
			if (!existsSync(indexHtml)) fail(`missing dist/index.html for ${dir}: ${indexHtml}`);
			else ok(`apps/${dir}/dist/index.html`);
		}
	}

	// art/emoji — the icon picker's built-in glyph set, served via
	// brainstorm://emoji/<codepoint>.webp. It lives OUTSIDE the asar as an
	// extraResources entry; forgetting it ships a picker full of broken
	// images (0.15.0 regression).
	const emojiDir = join(found.root, "art", "emoji");
	const sampleEmoji = join(emojiDir, "1f600.webp");
	if (!existsSync(sampleEmoji)) fail(`missing art/emoji extraResources (expected ${sampleEmoji})`);
	else ok(`art/emoji present (${readdirSync(emojiDir).length} glyphs)`);

	// at least one bundled .node — look in resources/app.asar.unpacked/
	// (asarUnpack rewrites the path) or anywhere under the resources root.
	const nativeFile = findFileRecursive(found.root, (_abs, name) => name.endsWith(".node"));
	if (!nativeFile) fail(`no bundled .node binary found under ${found.root}`);
	else ok(`native binary present at ${nativeFile}`);

	if (process.exitCode && process.exitCode !== 0) {
		console.error("[preview-package] artefact verification FAILED");
	} else {
		console.log("[preview-package] artefact verification PASSED");
	}
}

main();
