/**
 * 14.34 — first-party publish core. Reads a built app bundle dir
 * (`manifest.json` + `dist/**` + optional `icon.svg`/`assets/**`), packs it into
 * a signed `.brainstorm` archive, and produces the catalog version-entry fields
 * (sha256 + signature + publisher key) the catalog index serves.
 *
 * This is the testable core of the publish pipeline; the fs/CLI wrapper
 * (`tools/publish-first-party-catalog.ts`) iterates the first-party apps,
 * writes the `.brainstorm` files, and emits the catalog index. Per
 * §The publish pipeline. The seed is the publisher's Ed25519 private key (a CI
 * secret for real first-party releases; a dev seed locally).
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, posix, sep } from "node:path";
import { ed25519GetPublicKey } from "@brainstorm-os/native";
import { bundleSha256Hex, packBrainstormBundle, signBundleHash } from "./brainstorm-package";

/** Files always included from a bundle dir, plus everything under these dirs. */
const INCLUDED_TOP_FILES = ["manifest.json", "icon.svg"];
const INCLUDED_DIRS = ["dist", "assets"];

async function walkInto(root: string, rel: string, out: Map<string, Uint8Array>): Promise<void> {
	const abs = join(root, rel);
	const entries = await readdir(abs, { withFileTypes: true });
	for (const e of entries) {
		const childRel = rel.length === 0 ? e.name : `${rel}${sep}${e.name}`;
		if (e.isDirectory()) {
			await walkInto(root, childRel, out);
		} else if (e.isFile()) {
			out.set(
				childRel.split(sep).join(posix.sep),
				new Uint8Array(await readFile(join(root, childRel))),
			);
		}
	}
}

/**
 * Read a built app bundle dir into a path → bytes map (paths posix-normalised),
 * ready to pack. Includes `manifest.json` + `icon.svg` at the root and every
 * file under `dist/` + `assets/`. A missing top-level file is skipped; a missing
 * `dist/` throws (an unbuilt app can't be published).
 */
export async function readAppBundleFiles(bundleDir: string): Promise<Map<string, Uint8Array>> {
	const files = new Map<string, Uint8Array>();
	for (const name of INCLUDED_TOP_FILES) {
		try {
			files.set(name, new Uint8Array(await readFile(join(bundleDir, name))));
		} catch {
			// optional top-level file absent — skip
		}
	}
	let hasDir = false;
	for (const dir of INCLUDED_DIRS) {
		try {
			if ((await stat(join(bundleDir, dir))).isDirectory()) {
				await walkInto(bundleDir, dir, files);
				hasDir = true;
			}
		} catch {
			// dir absent — skip
		}
	}
	if (!hasDir || !files.has("manifest.json")) {
		throw new Error(
			`readAppBundleFiles: ${bundleDir} is not a built bundle (need manifest.json + dist/)`,
		);
	}
	return files;
}

export type PublishedBundle = {
	/** The signed `.brainstorm` archive bytes. */
	bytes: Uint8Array;
	/** Hex sha256 content address. */
	sha256: string;
	/** base64url Ed25519 signature over the content hash. */
	signature: string;
};

/** Pack + hash + sign a files map into a publishable `.brainstorm` bundle. */
export function buildPublishedBundle(
	files: ReadonlyMap<string, Uint8Array>,
	seed: Uint8Array,
): PublishedBundle {
	const bytes = packBrainstormBundle(files);
	const sha256 = bundleSha256Hex(bytes);
	return { bytes, sha256, signature: signBundleHash(sha256, seed) };
}

/** The wire publisher key (`ed25519:<base64url 32-byte>`) for a signing seed —
 *  what the catalog listing records and the client verifies against. */
export function publisherKeyForSeed(seed: Uint8Array): string {
	return `ed25519:${Buffer.from(ed25519GetPublicKey(seed)).toString("base64url")}`;
}
