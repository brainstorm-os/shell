import { describe, expect, it } from "vitest";
import { deepLinkFromArgv, parseEntityDeepLink } from "./deep-link";

describe("parseEntityDeepLink", () => {
	it("parses a bare entity URL", () => {
		expect(parseEntityDeepLink("brainstorm://entity/welcome-event-explore")).toBe(
			"welcome-event-explore",
		);
	});

	it("strips a #block anchor and a ?query", () => {
		expect(parseEntityDeepLink("brainstorm://entity/note_42#block-7")).toBe("note_42");
		expect(parseEntityDeepLink("brainstorm://entity/note_42?ref=x")).toBe("note_42");
	});

	it("returns null for non-entity / malformed / non-string input", () => {
		expect(parseEntityDeepLink("brainstorm://asset/abc")).toBeNull();
		expect(parseEntityDeepLink("brainstorm://entity/")).toBeNull();
		expect(parseEntityDeepLink("https://example.com")).toBeNull();
		expect(parseEntityDeepLink(undefined)).toBeNull();
		expect(parseEntityDeepLink(42)).toBeNull();
	});
});

describe("deepLinkFromArgv", () => {
	it("finds the first brainstorm:// arg", () => {
		expect(deepLinkFromArgv(["/path/electron", "app.js", "brainstorm://entity/x", "--flag"])).toBe(
			"brainstorm://entity/x",
		);
	});

	it("returns null when no deeplink arg is present", () => {
		expect(deepLinkFromArgv(["/path/electron", "app.js", "--flag"])).toBeNull();
		expect(deepLinkFromArgv([])).toBeNull();
		expect(deepLinkFromArgv(undefined)).toBeNull();
	});
});
