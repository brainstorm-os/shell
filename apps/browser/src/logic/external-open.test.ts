import type { Intent, LaunchContext } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { externalUrlFromIntent, externalUrlFromLaunch, isWebUrl } from "./external-open";

function openIntent(payload: Record<string, unknown>): Intent {
	return { verb: "open", payload, source: "io.brainstorm.bookmarks" };
}

describe("isWebUrl", () => {
	it("accepts http/https only", () => {
		expect(isWebUrl("https://example.com")).toBe(true);
		expect(isWebUrl("http://example.com")).toBe(true);
		expect(isWebUrl("HTTPS://EXAMPLE.COM")).toBe(true);
		expect(isWebUrl("file:///etc/passwd")).toBe(false);
		expect(isWebUrl("javascript:alert(1)")).toBe(false);
		expect(isWebUrl("brainstorm://entity/ent_1")).toBe(false);
	});
});

describe("externalUrlFromLaunch", () => {
	it("returns the deep-link web URL", () => {
		const launch: LaunchContext = { reason: "deep-link", deepLink: "https://example.com/a" };
		expect(externalUrlFromLaunch(launch)).toBe("https://example.com/a");
	});

	it("rejects non-web deep links", () => {
		const launch: LaunchContext = { reason: "deep-link", deepLink: "file:///etc/passwd" };
		expect(externalUrlFromLaunch(launch)).toBeNull();
	});

	it("ignores other launch reasons and absence", () => {
		expect(externalUrlFromLaunch({ reason: "fresh" })).toBeNull();
		expect(externalUrlFromLaunch(null)).toBeNull();
		expect(externalUrlFromLaunch(undefined)).toBeNull();
	});
});

describe("externalUrlFromIntent", () => {
	it("reads payload.url", () => {
		expect(externalUrlFromIntent(openIntent({ url: "https://example.com" }))).toBe(
			"https://example.com",
		);
	});

	it("falls back to payload.deepLink", () => {
		expect(externalUrlFromIntent(openIntent({ deepLink: "http://example.com" }))).toBe(
			"http://example.com",
		);
	});

	it("prefers url over deepLink", () => {
		expect(
			externalUrlFromIntent(openIntent({ url: "https://a.com", deepLink: "https://b.com" })),
		).toBe("https://a.com");
	});

	it("rejects non-open verbs, non-web URLs, malformed payloads", () => {
		expect(
			externalUrlFromIntent({ verb: "share", payload: { url: "https://a.com" }, source: "x" }),
		).toBeNull();
		expect(externalUrlFromIntent(openIntent({ url: "javascript:alert(1)" }))).toBeNull();
		expect(externalUrlFromIntent(openIntent({ url: 42 }))).toBeNull();
		expect(externalUrlFromIntent(openIntent({}))).toBeNull();
		expect(externalUrlFromIntent(null)).toBeNull();
	});
});
