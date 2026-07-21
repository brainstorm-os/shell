import { UpdateAvailability, UpdateChannel } from "@brainstorm-os/protocol/update-wire-types";
import { describe, expect, it } from "vitest";
import {
	candidateRelease,
	compareVersions,
	evaluateUpdate,
	parseReleaseFeed,
	parseVersion,
} from "./update-core";

describe("parseVersion", () => {
	it("parses plain semver", () => {
		expect(parseVersion("1.2.3")).toEqual({ core: [1, 2, 3], prerelease: [] });
	});
	it("tolerates a leading v and whitespace", () => {
		expect(parseVersion("  v0.0.1 ")).toEqual({ core: [0, 0, 1], prerelease: [] });
	});
	it("splits a prerelease into numeric + alpha identifiers", () => {
		expect(parseVersion("0.2.0-beta.1")).toEqual({ core: [0, 2, 0], prerelease: ["beta", 1] });
	});
	it("rejects non-semver", () => {
		expect(parseVersion("1.2")).toBeNull();
		expect(parseVersion("nightly")).toBeNull();
		expect(parseVersion("")).toBeNull();
	});
});

describe("compareVersions", () => {
	it("orders by core precedence", () => {
		expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
		expect(compareVersions("1.2.0", "1.1.9")).toBe(1);
		expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
	});
	it("sorts a prerelease below its release core", () => {
		expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
		expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
	});
	it("orders prereleases by identifier", () => {
		expect(compareVersions("1.0.0-beta.1", "1.0.0-beta.2")).toBe(-1);
		expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
		// numeric identifier outranked by alphanumeric
		expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
	});
	it("sorts an unparseable side last so garbage never reads as newer", () => {
		expect(compareVersions("garbage", "1.0.0")).toBe(-1);
		expect(compareVersions("1.0.0", "garbage")).toBe(1);
		expect(compareVersions("x", "y")).toBe(0);
	});
});

describe("parseReleaseFeed", () => {
	it("decodes a well-formed feed", () => {
		const feed = parseReleaseFeed({
			stable: { version: "1.0.0", downloadUrl: "https://x/1", notes: "n", publishedAt: "2026-06-01" },
			beta: { version: "1.1.0-beta.1", downloadUrl: "https://x/b" },
		});
		expect(feed.stable).toEqual({
			version: "1.0.0",
			downloadUrl: "https://x/1",
			notes: "n",
			publishedAt: "2026-06-01",
		});
		expect(feed.beta).toEqual({ version: "1.1.0-beta.1", downloadUrl: "https://x/b" });
	});
	it("drops a malformed channel entry but keeps the others", () => {
		const feed = parseReleaseFeed({
			stable: { version: "1.0.0", downloadUrl: "https://x/1" },
			beta: { version: "1.1.0" }, // missing downloadUrl
		});
		expect(feed.stable).toBeDefined();
		expect(feed.beta).toBeUndefined();
	});
	it("returns an empty feed for non-object input", () => {
		expect(parseReleaseFeed(null)).toEqual({});
		expect(parseReleaseFeed("nope")).toEqual({});
		expect(parseReleaseFeed(42)).toEqual({});
	});
});

describe("candidateRelease", () => {
	const feed = parseReleaseFeed({
		stable: { version: "1.0.0", downloadUrl: "https://x/1" },
		beta: { version: "1.1.0-beta.1", downloadUrl: "https://x/b" },
	});
	it("stable users get the stable entry", () => {
		expect(candidateRelease(feed, UpdateChannel.Stable)?.version).toBe("1.0.0");
	});
	it("beta users get the newer of beta vs stable", () => {
		expect(candidateRelease(feed, UpdateChannel.Beta)?.version).toBe("1.1.0-beta.1");
	});
	it("beta falls back to stable when stable is newer than the last beta", () => {
		const f = parseReleaseFeed({
			stable: { version: "2.0.0", downloadUrl: "https://x/2" },
			beta: { version: "1.1.0-beta.1", downloadUrl: "https://x/b" },
		});
		expect(candidateRelease(f, UpdateChannel.Beta)?.version).toBe("2.0.0");
	});
});

describe("evaluateUpdate", () => {
	const at = "2026-06-09T00:00:00.000Z";
	const feed = parseReleaseFeed({
		stable: { version: "1.0.0", downloadUrl: "https://x/1" },
		beta: { version: "1.2.0-beta.1", downloadUrl: "https://x/b" },
	});
	it("reports Available with the latest when a newer release exists", () => {
		const r = evaluateUpdate("0.9.0", feed, UpdateChannel.Stable, at);
		expect(r.availability).toBe(UpdateAvailability.Available);
		expect(r.latest?.version).toBe("1.0.0");
		expect(r.checkedAt).toBe(at);
	});
	it("reports UpToDate when current is equal or newer", () => {
		expect(evaluateUpdate("1.0.0", feed, UpdateChannel.Stable, at).availability).toBe(
			UpdateAvailability.UpToDate,
		);
		expect(evaluateUpdate("1.5.0", feed, UpdateChannel.Stable, at).availability).toBe(
			UpdateAvailability.UpToDate,
		);
	});
	it("a beta user is offered the newer beta build", () => {
		const r = evaluateUpdate("1.0.0", feed, UpdateChannel.Beta, at);
		expect(r.availability).toBe(UpdateAvailability.Available);
		expect(r.latest?.version).toBe("1.2.0-beta.1");
	});
	it("reports Unknown when the channel has no entry", () => {
		expect(evaluateUpdate("1.0.0", {}, UpdateChannel.Stable, at).availability).toBe(
			UpdateAvailability.Unknown,
		);
	});
	it("reports Unknown when the latest version is unparseable", () => {
		const bad = parseReleaseFeed({ stable: { version: "??", downloadUrl: "https://x" } });
		// parseReleaseFeed keeps it (version is a non-empty string) but evaluate guards parse.
		expect(evaluateUpdate("1.0.0", bad, UpdateChannel.Stable, at).availability).toBe(
			UpdateAvailability.Unknown,
		);
	});
});
