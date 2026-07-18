import { TabSecurityState } from "@brainstorm/sdk-types";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_TRACKER_BLOCKLIST,
	chromeEquivalentUserAgent,
	isBlockedRequest,
	isNavigationAllowed,
	isThirdPartyRequest,
	registrableDomain,
	securityStateForUrl,
	upgradeToHttps,
	withoutCookieHeader,
	withoutSetCookieHeaders,
} from "./web-policy";

describe("upgradeToHttps", () => {
	it("upgrades a plain http URL, preserving path + query", () => {
		expect(upgradeToHttps("http://example.com/a?b=1")).toBe("https://example.com/a?b=1");
	});

	it("returns null for an already-secure URL", () => {
		expect(upgradeToHttps("https://example.com/")).toBeNull();
	});

	it("does not upgrade loopback / localhost (no TLS there)", () => {
		expect(upgradeToHttps("http://localhost:5173/")).toBeNull();
		expect(upgradeToHttps("http://127.0.0.1:8080/x")).toBeNull();
		expect(upgradeToHttps("http://api.localhost/")).toBeNull();
	});

	it("returns null for non-http schemes and garbage", () => {
		expect(upgradeToHttps("about:blank")).toBeNull();
		expect(upgradeToHttps("file:///etc/passwd")).toBeNull();
		expect(upgradeToHttps("not a url")).toBeNull();
	});
});

describe("isBlockedRequest", () => {
	it("blocks a known tracker subdomain", () => {
		expect(isBlockedRequest("https://ads.doubleclick.net/x", DEFAULT_TRACKER_BLOCKLIST)).toBe(true);
		expect(
			isBlockedRequest("https://www.google-analytics.com/collect", DEFAULT_TRACKER_BLOCKLIST),
		).toBe(true);
	});

	it("does not block an ordinary site", () => {
		expect(isBlockedRequest("https://example.com/", DEFAULT_TRACKER_BLOCKLIST)).toBe(false);
		expect(isBlockedRequest("https://news.ycombinator.com/", DEFAULT_TRACKER_BLOCKLIST)).toBe(false);
	});

	it("never blocks an unparseable URL (let the engine reject it)", () => {
		expect(isBlockedRequest("::::", DEFAULT_TRACKER_BLOCKLIST)).toBe(false);
	});

	it("blocks nothing against an empty list", () => {
		expect(isBlockedRequest("https://ads.doubleclick.net/", [])).toBe(false);
	});
});

describe("chromeEquivalentUserAgent", () => {
	const electronUa =
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Brainstorm/0.5.3 Chrome/136.0.7103.115 Electron/36.3.2 Safari/537.36";

	it("strips the Electron and app-name tokens, keeping Chrome's shape", () => {
		expect(chromeEquivalentUserAgent(electronUa, "Brainstorm")).toBe(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.115 Safari/537.36",
		);
	});

	it("is a no-op on a UA that already has neither token", () => {
		const chrome =
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
		expect(chromeEquivalentUserAgent(chrome, "Brainstorm")).toBe(chrome);
	});

	it("escapes regex metacharacters in the app name", () => {
		const ua = "Mozilla/5.0 My.App/1.0 Chrome/1.0 Electron/2.0 Safari/537.36";
		expect(chromeEquivalentUserAgent(ua, "My.App")).toBe("Mozilla/5.0 Chrome/1.0 Safari/537.36");
	});

	it("works without an app name", () => {
		expect(chromeEquivalentUserAgent("Mozilla/5.0 Chrome/1.0 Electron/2.0 Safari/537.36")).toBe(
			"Mozilla/5.0 Chrome/1.0 Safari/537.36",
		);
	});
});

describe("securityStateForUrl", () => {
	it("maps schemes to badges", () => {
		expect(securityStateForUrl("https://example.com")).toBe(TabSecurityState.Secure);
		expect(securityStateForUrl("http://example.com")).toBe(TabSecurityState.Insecure);
		expect(securityStateForUrl("about:blank")).toBe(TabSecurityState.Local);
		expect(securityStateForUrl("")).toBe(TabSecurityState.Local);
		expect(securityStateForUrl("brainstorm://entity/1")).toBe(TabSecurityState.Local);
	});
});

describe("isNavigationAllowed", () => {
	it("allows http/https/about, refuses everything else (fail-closed)", () => {
		expect(isNavigationAllowed("https://example.com")).toBe(true);
		expect(isNavigationAllowed("http://example.com")).toBe(true);
		expect(isNavigationAllowed("about:blank")).toBe(true);
		expect(isNavigationAllowed("file:///etc/passwd")).toBe(false);
		expect(isNavigationAllowed("javascript:alert(1)")).toBe(false);
		expect(isNavigationAllowed("brainstorm://entity/1")).toBe(false);
		expect(isNavigationAllowed("garbage")).toBe(false);
	});
});

describe("registrableDomain", () => {
	it("collapses subdomains to eTLD+1", () => {
		expect(registrableDomain("news.example.com")).toBe("example.com");
		expect(registrableDomain("a.b.c.example.org")).toBe("example.org");
	});

	it("keeps known multi-label public suffixes together", () => {
		expect(registrableDomain("news.bbc.co.uk")).toBe("bbc.co.uk");
		expect(registrableDomain("shop.foo.com.au")).toBe("foo.com.au");
	});

	it("returns IP literals and short hosts unchanged", () => {
		expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
		expect(registrableDomain("localhost")).toBe("localhost");
		expect(registrableDomain("example.com")).toBe("example.com");
	});
});

describe("isThirdPartyRequest", () => {
	it("same registrable domain is first-party (subdomains included)", () => {
		expect(isThirdPartyRequest("https://cdn.example.com/x.js", "https://www.example.com/")).toBe(
			false,
		);
		expect(isThirdPartyRequest("https://example.com/a", "https://example.com/b")).toBe(false);
	});

	it("different registrable domain is third-party", () => {
		expect(isThirdPartyRequest("https://tracker.evil.net/p.gif", "https://example.com/")).toBe(true);
		expect(isThirdPartyRequest("https://evil.co.uk/x", "https://bbc.co.uk/")).toBe(true);
	});

	it("no first-party context yet (blank / empty) reads first-party", () => {
		expect(isThirdPartyRequest("https://example.com/", "")).toBe(false);
		expect(isThirdPartyRequest("https://example.com/", "about:blank")).toBe(false);
	});

	it("fails closed on an unparseable request URL under a real first party", () => {
		expect(isThirdPartyRequest("not a url", "https://example.com/")).toBe(true);
	});
});

describe("cookie header stripping", () => {
	it("strips Cookie case-insensitively, leaving other headers", () => {
		const headers = { Accept: "*/*", cookie: "a=1", Cookie: "b=2" };
		expect(withoutCookieHeader(headers)).toEqual({ Accept: "*/*" });
	});

	it("returns the same reference when nothing to strip", () => {
		const headers = { Accept: "*/*" };
		expect(withoutCookieHeader(headers)).toBe(headers);
	});

	it("strips Set-Cookie case-insensitively from response headers", () => {
		const headers = { "set-cookie": ["a=1"], "Content-Type": ["text/html"] };
		expect(withoutSetCookieHeaders(headers)).toEqual({ "Content-Type": ["text/html"] });
	});

	it("returns the same response-headers reference when nothing to strip", () => {
		const headers = { "Content-Type": ["text/html"] };
		expect(withoutSetCookieHeaders(headers)).toBe(headers);
	});
});
