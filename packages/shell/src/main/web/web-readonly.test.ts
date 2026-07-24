import { WEB_BROWSE_CAP, WEB_BROWSE_READONLY_CAP } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { BrowseMode, isReadOnlyRequestAllowed, resolveBrowseMode } from "./web-readonly";

describe("resolveBrowseMode — the mode comes from the VERIFIED caps", () => {
	it("gives full browsing to a caller that declared web.browse", () => {
		expect(resolveBrowseMode([WEB_BROWSE_CAP])).toBe(BrowseMode.Full);
	});

	it("gives read-only to a caller that declared only the sub-cap", () => {
		expect(resolveBrowseMode([WEB_BROWSE_READONLY_CAP])).toBe(BrowseMode.ReadOnly);
	});

	it("takes the WIDER mode when a caller declared both (it holds both)", () => {
		expect(resolveBrowseMode([WEB_BROWSE_READONLY_CAP, WEB_BROWSE_CAP])).toBe(BrowseMode.Full);
	});

	it("fails closed to read-only when no browse cap was declared at all", () => {
		// The broker would already have refused the call; this is defence in
		// depth, so a future caller can never get a full view by omission.
		expect(resolveBrowseMode([])).toBe(BrowseMode.ReadOnly);
		expect(resolveBrowseMode(["web.capture"])).toBe(BrowseMode.ReadOnly);
	});

	it("ignores a look-alike capability", () => {
		expect(resolveBrowseMode(["web.browsers", "web.browse:read-only-ish"])).toBe(BrowseMode.ReadOnly);
	});
});

describe("isReadOnlyRequestAllowed — what a read-only view may send", () => {
	it("allows the read verbs", () => {
		for (const method of ["GET", "HEAD", "get", "head"]) {
			expect(isReadOnlyRequestAllowed(method)).toBe(true);
		}
	});

	it("refuses every state-changing verb (a hostile page can't get a POST out)", () => {
		for (const method of ["POST", "PUT", "PATCH", "DELETE", "post", "OPTIONS", "TRACE"]) {
			expect(isReadOnlyRequestAllowed(method)).toBe(false);
		}
	});

	it("refuses an unknown or missing verb rather than guessing", () => {
		expect(isReadOnlyRequestAllowed("")).toBe(false);
		expect(isReadOnlyRequestAllowed(undefined)).toBe(false);
		expect(isReadOnlyRequestAllowed("BREW")).toBe(false);
	});
});
