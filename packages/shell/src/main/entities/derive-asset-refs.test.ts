/**
 * Asset-B4 — `derive-asset-refs` pure helpers: id extraction from arbitrary
 * property shapes + kind→role mapping.
 */

import { describe, expect, it } from "vitest";
import { AssetKind, AssetRefRole } from "../assets/asset-types";
import { assetRefRoleForKind, extractAssetIds } from "./derive-asset-refs";

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const url = (id: string) => `brainstorm://asset/${id}`;

describe("extractAssetIds", () => {
	it("pulls the id from a flat string property", () => {
		const ids = extractAssetIds({ faviconUrl: url(uuid(1)) });
		expect([...ids]).toEqual([uuid(1)]);
	});

	it("walks a nested object", () => {
		const ids = extractAssetIds({ meta: { cover: { src: url(uuid(2)) } } });
		expect([...ids]).toEqual([uuid(2)]);
	});

	it("walks an array of strings", () => {
		const ids = extractAssetIds({ gallery: [url(uuid(3)), "https://example.com", url(uuid(4))] });
		expect([...ids].sort()).toEqual([uuid(3), uuid(4)].sort());
	});

	it("extracts an id embedded mid-string (markdown / attachment field)", () => {
		const ids = extractAssetIds({
			body: `See the file ![diagram](${url(uuid(5))}) inline, plus (${url(uuid(6))}).`,
		});
		expect([...ids].sort()).toEqual([uuid(5), uuid(6)].sort());
	});

	it("collects multiple distinct assets across properties", () => {
		const ids = extractAssetIds({
			faviconUrl: url(uuid(7)),
			coverImageUrl: url(uuid(8)),
			attachment: url(uuid(9)),
		});
		expect([...ids].sort()).toEqual([uuid(7), uuid(8), uuid(9)].sort());
	});

	it("ignores non-asset URLs and non-string leaves", () => {
		const ids = extractAssetIds({
			link: "https://brainstorm.example/asset/not-ours",
			scheme: "other://asset/xyz",
			count: 3,
			flag: true,
			missing: null,
		});
		expect([...ids]).toEqual([]);
	});

	it("dedupes a repeated id (same asset referenced twice)", () => {
		const ids = extractAssetIds({
			faviconUrl: url(uuid(10)),
			body: `thumbnail ${url(uuid(10))} again`,
		});
		expect([...ids]).toEqual([uuid(10)]);
	});

	it("returns empty for a property bag with no asset URLs", () => {
		expect([...extractAssetIds({ title: "hello", n: 1 })]).toEqual([]);
	});
});

describe("assetRefRoleForKind", () => {
	it("maps favicon → favicon", () => {
		expect(assetRefRoleForKind(AssetKind.Favicon)).toBe(AssetRefRole.Favicon);
	});
	it("maps cover → cover", () => {
		expect(assetRefRoleForKind(AssetKind.Cover)).toBe(AssetRefRole.Cover);
	});
	it("maps upload → inline", () => {
		expect(assetRefRoleForKind(AssetKind.Upload)).toBe(AssetRefRole.Inline);
	});
});
