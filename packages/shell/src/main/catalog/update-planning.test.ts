import { UpdateChannel } from "@brainstorm-os/protocol/update-wire-types";
import { describe, expect, it } from "vitest";
import type { CatalogIndex } from "./catalog-wire-types";
import { type InstalledForUpdate, planCatalogUpdates } from "./update-planning";

function entry(version: string) {
	return {
		manifestUrl: `https://cdn.test/notes/manifest.json?v=${version}`,
		bundleUrl: `https://cdn.test/notes/io.brainstorm.notes-${version}.brainstorm`,
		sha256: "a".repeat(64),
		signature: "sig",
		sdk: "1",
		minShell: "1.0.0",
	};
}

function index(): CatalogIndex {
	return {
		catalogId: "brainstorm-official",
		generatedAt: 1,
		ttlSeconds: 3600,
		listings: [
			{
				id: "io.brainstorm.notes",
				kind: "app",
				publisherKey: "ed25519:notes-pub",
				name: "Notes",
				channels: { stable: "1.6.0", beta: "1.7.0-beta.1" },
				versions: { "1.6.0": entry("1.6.0"), "1.7.0-beta.1": entry("1.7.0-beta.1") },
				firstParty: true,
			},
		],
	};
}

const installed = (over: Partial<InstalledForUpdate> = {}): InstalledForUpdate => ({
	id: "io.brainstorm.notes",
	version: "1.5.0",
	channel: UpdateChannel.Stable,
	catalogTracked: true,
	publisherKey: "ed25519:notes-pub",
	...over,
});

describe("planCatalogUpdates", () => {
	it("flags a strictly newer catalog version on the install's channel", () => {
		const candidates = planCatalogUpdates([installed()], index());
		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			id: "io.brainstorm.notes",
			fromVersion: "1.5.0",
			toVersion: "1.6.0",
			channel: UpdateChannel.Stable,
			publisherKey: "ed25519:notes-pub",
		});
		expect(candidates[0]?.entry.bundleUrl).toContain("1.6.0");
	});

	it("resolves per the install's channel (beta sees the beta pointer)", () => {
		const candidates = planCatalogUpdates([installed({ channel: UpdateChannel.Beta })], index());
		expect(candidates[0]?.toVersion).toBe("1.7.0-beta.1");
	});

	it("skips same-or-older installed versions (never a downgrade)", () => {
		expect(planCatalogUpdates([installed({ version: "1.6.0" })], index())).toHaveLength(0);
		expect(planCatalogUpdates([installed({ version: "2.0.0" })], index())).toHaveLength(0);
	});

	it("skips non-catalog-tracked installs (sideload / local-file)", () => {
		expect(planCatalogUpdates([installed({ catalogTracked: false })], index())).toHaveLength(0);
	});

	it("skips apps absent from the catalog", () => {
		expect(planCatalogUpdates([installed({ id: "io.acme.absent" })], index())).toHaveLength(0);
	});

	it("refuses an update whose publisher key differs (TOFU continuity, fail-closed)", () => {
		// A hijacked catalog re-signs under an attacker key — the listing's key no
		// longer matches the install's anchor, so no update is offered.
		expect(
			planCatalogUpdates([installed({ publisherKey: "ed25519:attacker" })], index()),
		).toHaveLength(0);
	});

	it("allows the update when the install predates provenance (no anchor)", () => {
		expect(planCatalogUpdates([installed({ publisherKey: null })], index())).toHaveLength(1);
	});
});
