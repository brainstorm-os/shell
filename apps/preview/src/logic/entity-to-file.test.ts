import { describe, expect, test } from "vitest";
import { entityToPreviewFile } from "./entity-to-file";

describe("entityToPreviewFile", () => {
	test("resolves a Files `File/v1` row from its asset blob", () => {
		const file = entityToPreviewFile({
			id: "ent_1",
			properties: {
				name: "shot.png",
				assetId: "asset_abc",
				assetMime: "image/png",
				size: 2048,
			},
		});
		expect(file).not.toBeNull();
		expect(file?.source).toEqual({
			kind: "url",
			url: "brainstorm://asset/asset_abc",
			mime: "image/png",
			sizeBytes: 2048,
		});
		expect(file?.info.mime).toBe("image/png");
	});

	test("uses the served assetMime (not the truthful mime) for the asset path", () => {
		// The asset protocol downgrades active content: an `.svg` uploads as
		// `image/svg+xml` but serves `application/octet-stream`. Preview must pick
		// what the fetch will return so it doesn't mount an image renderer on
		// inert bytes — it should fall through to the honest "no preview" pane.
		const file = entityToPreviewFile({
			id: "ent_svg",
			properties: {
				name: "diagram.svg",
				mime: "image/svg+xml",
				assetId: "asset_svg",
				assetMime: "application/octet-stream",
			},
		});
		expect(file?.source.mime).toBe("application/octet-stream");
	});

	test("prefers an explicit attachment URL + mime over the asset blob", () => {
		const file = entityToPreviewFile({
			id: "ent_2",
			properties: {
				name: "doc.pdf",
				mime: "application/pdf",
				attachment: "https://example.test/doc.pdf",
				assetId: "asset_should_be_ignored",
				assetMime: "image/png",
			},
		});
		expect(file?.source).toEqual({
			kind: "url",
			url: "https://example.test/doc.pdf",
			mime: "application/pdf",
			sizeBytes: null,
		});
	});

	test("returns null when there is neither an attachment URL nor an asset id", () => {
		expect(
			entityToPreviewFile({ id: "ent_3", properties: { name: "x", mime: "text/plain" } }),
		).toBeNull();
	});

	test("returns null when there is no MIME to pick a renderer", () => {
		expect(
			entityToPreviewFile({ id: "ent_4", properties: { name: "x", assetId: "asset_z" } }),
		).toBeNull();
	});

	test("reads Modified from the entity's own updatedAt when the row carries none", () => {
		// A freshly imported `File/v1` row has no `properties.updatedAt`; its
		// recency lives on the envelope, which is what Files' "Today" reads.
		const file = entityToPreviewFile({
			id: "ent_5",
			updatedAt: 1_700_000_000_000,
			properties: { name: "a.png", assetId: "asset_a", assetMime: "image/png" },
		});
		expect(file?.info.modifiedAt).toBe(1_700_000_000_000);
	});

	test("prefers the envelope updatedAt over a stale property copy", () => {
		const file = entityToPreviewFile({
			id: "ent_6",
			updatedAt: 2_000,
			properties: { name: "a.png", assetId: "asset_a", assetMime: "image/png", updatedAt: 1_000 },
		});
		expect(file?.info.modifiedAt).toBe(2_000);
	});

	test("still reads a property updatedAt when the envelope has none", () => {
		const file = entityToPreviewFile({
			id: "ent_7",
			properties: { name: "a.png", assetId: "asset_a", assetMime: "image/png", updatedAt: 1_000 },
		});
		expect(file?.info.modifiedAt).toBe(1_000);
	});
});
