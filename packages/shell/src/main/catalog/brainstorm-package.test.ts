import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519GetPublicKey } from "@brainstorm-os/native";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	bundleSha256Hex,
	packBrainstormBundle,
	parseEd25519PublisherKey,
	signBundleHash,
	unpackBrainstormBundle,
	unpackBrainstormBundleToDir,
	verifyBundleSignature,
} from "./brainstorm-package";

const SEED = new Uint8Array(32).map((_, i) => (i + 5) & 0xff);
const PUBLISHER = `ed25519:${Buffer.from(ed25519GetPublicKey(SEED)).toString("base64url")}`;

function sampleFiles(): Map<string, Uint8Array> {
	const enc = new TextEncoder();
	return new Map<string, Uint8Array>([
		["manifest.json", enc.encode('{"id":"io.example.app","version":"1.0.0"}')],
		["dist/index.html", enc.encode("<!doctype html><html><body>hi</body></html>")],
		["assets/icon.svg", enc.encode("<svg/>")],
	]);
}

describe("brainstorm-package — pack/unpack", () => {
	it("round-trips files through tar+gzip", () => {
		const files = sampleFiles();
		const bytes = packBrainstormBundle(files);
		const out = unpackBrainstormBundle(bytes);
		expect(new TextDecoder().decode(out.get("manifest.json"))).toContain("io.example.app");
		expect(new TextDecoder().decode(out.get("dist/index.html"))).toContain("hi");
		expect(out.size).toBe(3);
	});

	it("is deterministic — same content → same bytes (stable content address)", () => {
		const a = packBrainstormBundle(sampleFiles());
		const b = packBrainstormBundle(sampleFiles());
		expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
		expect(bundleSha256Hex(a)).toBe(bundleSha256Hex(b));
	});

	it("uses gzip (code 1) so any client runtime can decompress", () => {
		const bytes = packBrainstormBundle(sampleFiles());
		// header: "BSB1" (4) + version (1) + compression code (1); 1 = gzip.
		expect(Buffer.from(bytes.subarray(0, 4)).toString("ascii")).toBe("BSB1");
		expect(bytes[5]).toBe(1);
	});
});

describe("brainstorm-package — unpack to dir", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bs-pkg-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("writes nested files under the dest dir", async () => {
		const bytes = packBrainstormBundle(sampleFiles());
		const out = await unpackBrainstormBundleToDir(bytes, dir);
		expect(out).toBe(dir);
		expect(await readFile(join(dir, "manifest.json"), "utf8")).toContain("io.example.app");
		expect(await readFile(join(dir, "dist", "index.html"), "utf8")).toContain("hi");
	});
});

describe("brainstorm-package — sign/verify", () => {
	it("verifies a signature the packer produced over the bundle hash", () => {
		const bytes = packBrainstormBundle(sampleFiles());
		const hash = bundleSha256Hex(bytes);
		const sig = signBundleHash(hash, SEED);
		expect(verifyBundleSignature(hash, sig, PUBLISHER)).toBe(true);
	});

	it("rejects a tampered hash", () => {
		const sig = signBundleHash(bundleSha256Hex(packBrainstormBundle(sampleFiles())), SEED);
		expect(verifyBundleSignature("a".repeat(64), sig, PUBLISHER)).toBe(false);
	});

	it("rejects the wrong publisher key", () => {
		const bytes = packBrainstormBundle(sampleFiles());
		const hash = bundleSha256Hex(bytes);
		const sig = signBundleHash(hash, SEED);
		const otherKey = `ed25519:${Buffer.from(ed25519GetPublicKey(new Uint8Array(32).fill(1))).toString("base64url")}`;
		expect(verifyBundleSignature(hash, sig, otherKey)).toBe(false);
	});

	it("returns false (never throws) on malformed inputs", () => {
		expect(verifyBundleSignature("nothex", "x", PUBLISHER)).toBe(false);
		expect(verifyBundleSignature("a".repeat(64), "not base64url!!", PUBLISHER)).toBe(false);
		expect(verifyBundleSignature("a".repeat(64), "AAAA", "ed25519:dev-placeholder")).toBe(false);
		expect(verifyBundleSignature("a".repeat(64), "AAAA", "not-a-key")).toBe(false);
	});
});

describe("brainstorm-package — parseEd25519PublisherKey", () => {
	it("parses a valid 32-byte key", () => {
		expect(parseEd25519PublisherKey(PUBLISHER)?.length).toBe(32);
	});
	it("rejects missing prefix, wrong length, dev placeholder", () => {
		expect(parseEd25519PublisherKey("dev-brainstorm")).toBeNull();
		expect(parseEd25519PublisherKey("ed25519:dev-brainstorm")).toBeNull();
		expect(
			parseEd25519PublisherKey(`ed25519:${Buffer.from("short").toString("base64url")}`),
		).toBeNull();
	});
});
