import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	AppIconMiss,
	appIconMissStatus,
	isAppIconHit,
	resolveAppIconInBundle,
} from "./app-icon-resolver";

const BUNDLE = join("/vaults", "v1", "apps", "studio.northbound.client-pulse", "1.0.0");

/** Bundle IO stub: a manifest object plus the files that exist on disk. */
const io = (manifest: unknown, files: readonly string[] = []) => ({
	readManifest: async () => JSON.stringify(manifest),
	fileExists: async (path: string) => files.includes(path),
});

describe("resolveAppIconInBundle", () => {
	it("resolves a declared icon inside the bundle", async () => {
		const resolved = await resolveAppIconInBundle(
			BUNDLE,
			io({ id: "x", icon: "icon.svg" }, [join(BUNDLE, "icon.svg")]),
		);
		expect(isAppIconHit(resolved)).toBe(true);
		expect(resolved).toEqual({ path: join(BUNDLE, "icon.svg") });
	});

	it("resolves an icon in a subdirectory", async () => {
		const resolved = await resolveAppIconInBundle(
			BUNDLE,
			io({ icon: "assets/icon.png" }, [join(BUNDLE, "assets", "icon.png")]),
		);
		expect(resolved).toEqual({ path: join(BUNDLE, "assets", "icon.png") });
	});

	// POLISH-LAY-8 — the sideloaded Client Pulse / Hello case: no `icon` key at
	// all. Not an error; the caller draws initials.
	it("reports NoIcon for a manifest with no icon key", async () => {
		expect(await resolveAppIconInBundle(BUNDLE, io({ id: "x" }))).toEqual({
			miss: AppIconMiss.NoIcon,
		});
	});

	it("reports NoIcon for an empty or non-string icon", async () => {
		expect(await resolveAppIconInBundle(BUNDLE, io({ icon: "" }))).toEqual({
			miss: AppIconMiss.NoIcon,
		});
		expect(await resolveAppIconInBundle(BUNDLE, io({ icon: 7 }))).toEqual({
			miss: AppIconMiss.NoIcon,
		});
	});

	it("reports NoIcon for a declared icon that isn't on disk", async () => {
		// Never hand the caller a path it will fetch as a missing `file://`
		// (ERR_UNEXPECTED in the renderer) — the app simply has no artwork.
		expect(await resolveAppIconInBundle(BUNDLE, io({ icon: "icon.svg" }, []))).toEqual({
			miss: AppIconMiss.NoIcon,
		});
	});

	it("refuses a path that escapes the bundle", async () => {
		expect(
			await resolveAppIconInBundle(BUNDLE, io({ icon: "../../secrets.png" }, ["/vaults/secrets.png"])),
		).toEqual({ miss: AppIconMiss.NoIcon });
	});

	it("contains an absolute-looking icon path inside the bundle", async () => {
		// `join` treats a leading slash as relative, so `/etc/passwd` can only
		// ever address `<bundle>/etc/passwd` — and that doesn't exist.
		expect(
			await resolveAppIconInBundle(BUNDLE, io({ icon: "/etc/passwd" }, ["/etc/passwd"])),
		).toEqual({ miss: AppIconMiss.NoIcon });
	});

	it("reports Unresolved when the app has no active bundle", async () => {
		expect(await resolveAppIconInBundle(null)).toEqual({ miss: AppIconMiss.Unresolved });
	});

	it("reports Unresolved when the manifest is missing or unparseable", async () => {
		expect(
			await resolveAppIconInBundle(BUNDLE, {
				readManifest: async () => {
					throw new Error("ENOENT");
				},
			}),
		).toEqual({ miss: AppIconMiss.Unresolved });
		expect(await resolveAppIconInBundle(BUNDLE, { readManifest: async () => "{ not json" })).toEqual({
			miss: AppIconMiss.Unresolved,
		});
	});
});

describe("appIconMissStatus", () => {
	it("answers 204 for a declared-no-icon app so no console 404 is logged", () => {
		expect(appIconMissStatus(AppIconMiss.NoIcon)).toBe(204);
	});

	it("keeps 404 meaningful for an id that resolves to nothing installed", () => {
		expect(appIconMissStatus(AppIconMiss.Unresolved)).toBe(404);
	});
});
