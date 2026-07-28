/**
 * Asset-B4b — the native thumbnail transform, on real decodable bytes.
 * Policy (eligibility, keep-or-drop) is TS-side and tested in the shell;
 * these pin the transform contract: bounded resize, format choice, fail-
 * closed rejection of hostile/undecodable input.
 */
import { describe, expect, it } from "vitest";
import { imageThumbnail } from "../index.js";
import { buildPackagedNativePath } from "../packaged-resolver.cjs";
import { makePng } from "./fixtures";

describe("imageThumbnail", () => {
	it("downscales an oversized image to the long-edge bound, preserving aspect", async () => {
		const png = makePng({ width: 1000, height: 800, noise: true });
		const result = await imageThumbnail(png, 512, 80);
		expect(result.sourceWidth).toBe(1000);
		expect(result.sourceHeight).toBe(800);
		expect(result.width).toBe(512);
		expect(result.height).toBe(410); // round(800 * 512/1000)
		expect(result.bytes.length).toBeGreaterThan(0);
	});

	it("re-encodes a fully-opaque source as JPEG even when it carries an alpha channel", async () => {
		const png = makePng({ width: 900, height: 300, rgba: [10, 200, 30, 255], noise: true });
		const result = await imageThumbnail(png, 512, 80);
		expect(result.mime).toBe("image/jpeg");
		// JPEG magic.
		expect(result.bytes[0]).toBe(0xff);
		expect(result.bytes[1]).toBe(0xd8);
	});

	it("keeps genuinely transparent sources as PNG", async () => {
		const png = makePng({ width: 800, height: 800, rgba: [10, 20, 30, 128] });
		const result = await imageThumbnail(png, 512, 80);
		expect(result.mime).toBe("image/png");
		expect(result.width).toBe(512);
		// PNG magic.
		expect(result.bytes[0]).toBe(0x89);
		expect(result.bytes[1]).toBe(0x50);
	});

	it("leaves an already-small image at its native size (re-encode only)", async () => {
		const png = makePng({ width: 300, height: 200, noise: true });
		const result = await imageThumbnail(png, 512, 80);
		expect(result.width).toBe(300);
		expect(result.height).toBe(200);
	});

	it("round-trips its own JPEG output (jpeg decode path)", async () => {
		const first = await imageThumbnail(makePng({ width: 1200, height: 900, noise: true }), 512, 80);
		expect(first.mime).toBe("image/jpeg");
		const second = await imageThumbnail(Buffer.from(first.bytes), 128, 80);
		expect(second.mime).toBe("image/jpeg");
		expect(second.width).toBe(128);
	});

	it("rejects garbage bytes (fail closed)", async () => {
		await expect(imageThumbnail(Buffer.from("not an image at all"), 512, 80)).rejects.toThrow();
	});

	it("rejects a source whose declared dimensions exceed the decode limit", async () => {
		// A real PNG whose IHDR declares 1×20000 — over the 16384 edge cap.
		const png = makePng({ width: 1, height: 20_000 });
		await expect(imageThumbnail(png, 512, 80)).rejects.toThrow();
	});

	it("rejects out-of-range parameters (sync throw from the factory)", async () => {
		const png = makePng({ width: 32, height: 32 });
		// Parameter validation fails BEFORE the async task is queued.
		await expect(async () => imageThumbnail(png, 0, 80)).rejects.toThrow();
		await expect(async () => imageThumbnail(png, 512, 0)).rejects.toThrow();
		await expect(async () => imageThumbnail(png, 512, 101)).rejects.toThrow();
	});
});

describe("packaged resolution", () => {
	it("maps to the brainstorm-image binary name under resources/native", () => {
		expect(buildPackagedNativePath("/res", "darwin", "arm64")).toBe(
			"/res/native/brainstorm-image.darwin-arm64.node",
		);
		expect(buildPackagedNativePath("/res", "win32", "x64")).toBe(
			"/res/native/brainstorm-image.win32-x64-msvc.node",
		);
		expect(buildPackagedNativePath("/res", "linux", "x64")).toBe(
			"/res/native/brainstorm-image.linux-x64-gnu.node",
		);
	});
});
