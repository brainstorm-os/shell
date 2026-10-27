import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The `brainstorm://` protocol handler serves static art from
 * `process.resourcesPath/art` when packaged — and electron-builder only
 * copies what `build.extraResources` names. Every directory the handler
 * reads from there must be listed, or the packaged app silently 404s what
 * dev (which reads `packages/shell/art` straight from source) renders fine.
 * 0.15.0 shipped without `art/emoji`: the icon picker's emoji grid and
 * category tabs were all broken images.
 */
const PKG_DIR = join(__dirname, "../..");
const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as {
	build: { extraResources: Array<{ from: string; to: string; filter?: string[] }> };
};
const extra = pkg.build.extraResources;

describe("packaged extraResources", () => {
	it("ships the emoji glyph set the brainstorm://emoji handler serves", () => {
		const entry = extra.find((e) => e.to === "art/emoji");
		expect(entry?.from).toBe("art/emoji");
		// The filter must admit the files that are actually there.
		const files = readdirSync(join(PKG_DIR, "art", "emoji"));
		expect(files.length).toBeGreaterThan(1000);
		expect(files.every((f) => f.endsWith(".webp"))).toBe(true);
		if (entry?.filter) expect(entry.filter).toContain("*.webp");
	});

	it("ships the wallpapers and the tray/app icons", () => {
		expect(extra.find((e) => e.to === "art/wallpaper")?.from).toBe("art/wallpaper");
		const icons = extra.find((e) => e.to === "art" && e.from === "art");
		expect(icons?.filter).toEqual(
			expect.arrayContaining(["icon.png", "tray.png", "trayTemplate.png"]),
		);
	});
});
