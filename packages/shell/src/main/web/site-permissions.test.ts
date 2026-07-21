import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SitePermissionKind } from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	SitePermissionStore,
	parseSitePermissionGrants,
	readSitePermissionGrants,
	sitePermissionKindsFor,
	sitePermissionsPath,
	webOriginOf,
	writeSitePermissionGrants,
} from "./site-permissions";

describe("sitePermissionKindsFor", () => {
	it("maps geolocation", () => {
		expect(sitePermissionKindsFor("geolocation")).toEqual([SitePermissionKind.Geolocation]);
	});

	it("fans media out per mediaTypes", () => {
		expect(sitePermissionKindsFor("media", ["video"])).toEqual([SitePermissionKind.Camera]);
		expect(sitePermissionKindsFor("media", ["audio"])).toEqual([SitePermissionKind.Microphone]);
		expect(sitePermissionKindsFor("media", ["audio", "video"])).toEqual([
			SitePermissionKind.Camera,
			SitePermissionKind.Microphone,
		]);
	});

	it("media without mediaTypes is not grantable", () => {
		expect(sitePermissionKindsFor("media")).toEqual([]);
	});

	it("everything else stays deny-always (not grantable)", () => {
		expect(sitePermissionKindsFor("notifications")).toEqual([]);
		expect(sitePermissionKindsFor("pointerLock")).toEqual([]);
		expect(sitePermissionKindsFor("openExternal")).toEqual([]);
	});
});

describe("webOriginOf", () => {
	it("serializes http(s) origins", () => {
		expect(webOriginOf("https://example.com/a/b?c=1")).toBe("https://example.com");
		expect(webOriginOf("http://example.com:8080/")).toBe("http://example.com:8080");
	});

	it("rejects non-web schemes and garbage", () => {
		expect(webOriginOf("about:blank")).toBeNull();
		expect(webOriginOf("file:///etc/passwd")).toBeNull();
		expect(webOriginOf("not a url")).toBeNull();
	});
});

describe("SitePermissionStore", () => {
	const origin = "https://example.com";

	it("deny-default: unset decision is null, isAllowed false", () => {
		const store = new SitePermissionStore();
		expect(store.decision(origin, SitePermissionKind.Camera)).toBeNull();
		expect(store.isAllowed(origin, SitePermissionKind.Camera)).toBe(false);
	});

	it("explicit allow / block round-trips per origin+kind", () => {
		const store = new SitePermissionStore();
		store.set(origin, SitePermissionKind.Camera, true, 1);
		store.set(origin, SitePermissionKind.Microphone, false, 2);
		expect(store.decision(origin, SitePermissionKind.Camera)).toBe(true);
		expect(store.decision(origin, SitePermissionKind.Microphone)).toBe(false);
		expect(store.decision(origin, SitePermissionKind.Geolocation)).toBeNull();
		expect(store.decision("https://other.com", SitePermissionKind.Camera)).toBeNull();
	});

	it("revokeOrigin drops every kind for the origin only", () => {
		const store = new SitePermissionStore();
		store.set(origin, SitePermissionKind.Camera, true, 1);
		store.set(origin, SitePermissionKind.Geolocation, false, 2);
		store.set("https://other.com", SitePermissionKind.Camera, true, 3);
		expect(store.revokeOrigin(origin)).toBe(true);
		expect(store.decision(origin, SitePermissionKind.Camera)).toBeNull();
		expect(store.decision("https://other.com", SitePermissionKind.Camera)).toBe(true);
		expect(store.revokeOrigin(origin)).toBe(false);
	});

	it("list is sorted and reflects the latest decision", () => {
		const store = new SitePermissionStore();
		store.set("https://b.com", SitePermissionKind.Camera, true, 1);
		store.set("https://a.com", SitePermissionKind.Geolocation, false, 2);
		store.set("https://b.com", SitePermissionKind.Camera, false, 3);
		expect(store.list()).toEqual([
			{
				origin: "https://a.com",
				permission: SitePermissionKind.Geolocation,
				allow: false,
				updatedAt: 2,
			},
			{ origin: "https://b.com", permission: SitePermissionKind.Camera, allow: false, updatedAt: 3 },
		]);
	});
});

describe("parseSitePermissionGrants", () => {
	it("drops malformed rows, keeps valid ones", () => {
		const valid = {
			origin: "https://example.com",
			permission: "camera",
			allow: true,
			updatedAt: 5,
		};
		expect(
			parseSitePermissionGrants([
				valid,
				{ origin: "example.com", permission: "camera", allow: true, updatedAt: 1 },
				{ origin: "https://x.com", permission: "midi", allow: true, updatedAt: 1 },
				{ origin: "https://x.com", permission: "camera", allow: "yes", updatedAt: 1 },
				"junk",
				null,
			]),
		).toEqual([valid]);
	});

	it("non-array input parses to empty", () => {
		expect(parseSitePermissionGrants({})).toEqual([]);
		expect(parseSitePermissionGrants("x")).toEqual([]);
	});
});

describe("grant file round-trip", () => {
	let vault: string;

	beforeEach(async () => {
		vault = await mkdtemp(join(tmpdir(), "bs-siteperm-"));
	});

	afterEach(async () => {
		await rm(vault, { recursive: true, force: true });
	});

	it("writes then reads grants back", async () => {
		const grants = [
			{
				origin: "https://example.com",
				permission: SitePermissionKind.Camera,
				allow: true,
				updatedAt: 7,
			},
		];
		await writeSitePermissionGrants(vault, grants);
		expect(await readSitePermissionGrants(vault)).toEqual(grants);
		expect((await readFile(sitePermissionsPath(vault), "utf8")).endsWith("\n")).toBe(true);
	});

	it("missing file reads as empty (deny-default)", async () => {
		expect(await readSitePermissionGrants(vault)).toEqual([]);
	});
});
