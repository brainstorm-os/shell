import { describe, expect, it } from "vitest";
import { collisionName, sha256Hex, splitName } from "./upload";

describe("splitName", () => {
	it("splits stem and dotted extension", () => {
		expect(splitName("report.pdf")).toEqual({ stem: "report", ext: ".pdf" });
		expect(splitName("photo.tar.gz")).toEqual({ stem: "photo.tar", ext: ".gz" });
	});

	it("treats a dotfile as stem-only (no extension)", () => {
		expect(splitName(".bashrc")).toEqual({ stem: ".bashrc", ext: "" });
	});

	it("returns the whole name as stem when there is no extension", () => {
		expect(splitName("README")).toEqual({ stem: "README", ext: "" });
	});
});

describe("collisionName", () => {
	it("inserts ` (N)` before the extension so the MIME hint survives", () => {
		expect(collisionName("report.pdf", 2)).toBe("report (2).pdf");
		expect(collisionName("photo.tar.gz", 3)).toBe("photo.tar (3).gz");
	});

	it("appends ` (N)` to extensionless names", () => {
		expect(collisionName("README", 2)).toBe("README (2)");
	});
});

describe("sha256Hex", () => {
	it("hashes the empty input to the well-known SHA-256 digest", async () => {
		const empty = new Uint8Array(0);
		expect(await sha256Hex(empty)).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});

	it('hashes "abc" to the FIPS-180-2 reference digest', async () => {
		const abc = new TextEncoder().encode("abc");
		expect(await sha256Hex(abc)).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	it("produces a stable 64-char lowercase-hex string", async () => {
		const hash = await sha256Hex(new TextEncoder().encode("hello world"));
		expect(hash).toHaveLength(64);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});
});
