import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BOOTSTRAP_APPS,
	FIRST_PARTY_APPS,
	firstPartyAppById,
	firstPartyAppsDir,
	readFirstPartyCatalog,
	resolveFirstPartyAppsDir,
} from "./first-party";

describe("BOOTSTRAP_APPS", () => {
	it("installs every bundled first-party app on first run (no curated-subset stranding)", () => {
		// Regression: a curated subset left non-bootstrap apps (e.g. code-editor)
		// NotInstalled with no install path in shipped/dogfood shells. All
		// first-party apps are bundled, so all bootstrap-install offline.
		expect(BOOTSTRAP_APPS).toEqual(FIRST_PARTY_APPS);
		expect(BOOTSTRAP_APPS.some((a) => a.expectedAppId === "io.brainstorm.code-editor")).toBe(true);
	});
});

describe("firstPartyAppsDir", () => {
	it("walks up four levels from the compiled main dir to <repo>/apps", () => {
		expect(firstPartyAppsDir("/r/packages/shell/out/main")).toBe("/r/apps");
	});
});

describe("resolveFirstPartyAppsDir", () => {
	it("uses the dev relative walk when not packaged", () => {
		expect(
			resolveFirstPartyAppsDir("/r/packages/shell/out/main", {
				isPackaged: false,
				resourcesPath: "/unused",
			}),
		).toBe("/r/apps");
	});

	it("uses the extraResources tree when packaged — the asar-relative walk does not exist there", () => {
		expect(
			resolveFirstPartyAppsDir("/Applications/Brainstorm.app/Contents/Resources/app.asar/out/main", {
				isPackaged: true,
				resourcesPath: "/Applications/Brainstorm.app/Contents/Resources",
			}),
		).toBe("/Applications/Brainstorm.app/Contents/Resources/apps");
	});
});

describe("firstPartyAppById", () => {
	it("resolves a known id and returns undefined for an unknown one", () => {
		expect(firstPartyAppById("io.brainstorm.notes")?.dir).toBe("notes");
		expect(firstPartyAppById("io.brainstorm.unknown")).toBeUndefined();
	});
});

describe("readFirstPartyCatalog", () => {
	let appsDir: string;

	beforeEach(async () => {
		appsDir = await mkdtemp(join(tmpdir(), "bs-fp-"));
	});
	afterEach(async () => {
		await rm(appsDir, { recursive: true, force: true });
	});

	async function writeManifest(dir: string, manifest: unknown): Promise<void> {
		await mkdir(join(appsDir, dir), { recursive: true });
		await writeFile(join(appsDir, dir, "manifest.json"), JSON.stringify(manifest), "utf8");
	}

	it("reads id/name/version/description from each readable manifest", async () => {
		await writeManifest("notes", {
			id: "io.brainstorm.notes",
			name: "Notes",
			version: "0.1.0",
			description: "Plain-text notes",
		});
		const catalog = await readFirstPartyCatalog(appsDir);
		const notes = catalog.find((e) => e.id === "io.brainstorm.notes");
		expect(notes).toEqual({
			id: "io.brainstorm.notes",
			name: "Notes",
			version: "0.1.0",
			description: "Plain-text notes",
		});
	});

	it("soft-skips dirs with a missing or unparseable manifest", async () => {
		await writeManifest("notes", { id: "io.brainstorm.notes", name: "Notes", version: "0.1.0" });
		await mkdir(join(appsDir, "files"), { recursive: true });
		await writeFile(join(appsDir, "files", "manifest.json"), "{ not json", "utf8");

		const catalog = await readFirstPartyCatalog(appsDir);
		expect(catalog.map((e) => e.id)).toEqual(["io.brainstorm.notes"]);
	});

	it("omits description when the manifest has none", async () => {
		await writeManifest("notes", { id: "io.brainstorm.notes", name: "Notes", version: "0.1.0" });
		const [notes] = await readFirstPartyCatalog(appsDir);
		expect(notes && "description" in notes).toBe(false);
	});

	it("returns an empty catalog when the apps dir has nothing", async () => {
		expect(await readFirstPartyCatalog(appsDir)).toEqual([]);
	});

	it("only considers dirs in the first-party list", () => {
		// Guard: the catalog reader iterates FIRST_PARTY_APPS, so an arbitrary
		// dir dropped into apps/ is never surfaced.
		expect(FIRST_PARTY_APPS.some((a) => a.dir === "notes")).toBe(true);
		expect(FIRST_PARTY_APPS.some((a) => a.dir === "evil")).toBe(false);
	});
});
