/**
 * 13.6 — beta-channel manual-download update mechanism (pure core).
 *
 * Three pure functions, no IO, fully unit-tested:
 *   - `compareVersions` — semver-lite ordering (MAJOR.MINOR.PATCH with an
 *     optional `-prerelease` suffix; a prerelease sorts BELOW its release
 *     core, per semver §11).
 *   - `parseReleaseFeed` — defensive decode of the served JSON feed; a
 *     malformed channel entry is dropped, never fatal.
 *   - `evaluateUpdate` — current version × feed × channel → a resolved
 *     `UpdateCheckResult`. Total: every path returns, none throws.
 *
 * The shell never installs anything; `evaluateUpdate` only decides whether
 * a newer download exists and which one to point the user at.
 */

import {
	type ReleaseFeed,
	type ReleaseInfo,
	UpdateAvailability,
	UpdateChannel,
	type UpdateCheckResult,
} from "@brainstorm-os/protocol/update-wire-types";

type ParsedVersion = {
	readonly core: readonly [number, number, number];
	/** Empty when the version is a plain release (no `-prerelease`). */
	readonly prerelease: readonly (string | number)[];
};

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Parse `MAJOR.MINOR.PATCH[-prerelease]` (a leading `v` is tolerated).
 *  Returns null on anything that isn't a clean semver-lite string. */
export function parseVersion(value: string): ParsedVersion | null {
	const match = VERSION_RE.exec(value.trim());
	if (match === null) return null;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
		return null;
	}
	const prerelease =
		match[4] === undefined
			? []
			: match[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id));
	return { core: [major, minor, patch], prerelease };
}

/** Total ordering on version strings: -1 if `a < b`, 1 if `a > b`, 0 if
 *  equal. An unparseable side sorts LAST (so a garbage `latest` never
 *  reads as "newer than current"). */
export function compareVersions(a: string, b: string): number {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (pa === null && pb === null) return 0;
	if (pa === null) return -1;
	if (pb === null) return 1;
	for (let i = 0; i < 3; i++) {
		const diff = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
		if (diff !== 0) return diff < 0 ? -1 : 1;
	}
	// Equal cores: a release (no prerelease) outranks a prerelease.
	if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
	if (pa.prerelease.length === 0) return 1;
	if (pb.prerelease.length === 0) return -1;
	return comparePrerelease(pa.prerelease, pb.prerelease);
}

function comparePrerelease(
	a: readonly (string | number)[],
	b: readonly (string | number)[],
): number {
	const len = Math.max(a.length, b.length);
	for (let i = 0; i < len; i++) {
		const ai = a[i];
		const bi = b[i];
		// A shorter prerelease set sorts below a longer one with the same prefix.
		if (ai === undefined) return -1;
		if (bi === undefined) return 1;
		const aNum = typeof ai === "number";
		const bNum = typeof bi === "number";
		if (aNum && bNum) {
			if (ai !== bi) return ai < bi ? -1 : 1;
		} else if (aNum !== bNum) {
			// Numeric identifiers always have lower precedence than alphanumeric.
			return aNum ? -1 : 1;
		} else if (ai !== bi) {
			return ai < bi ? -1 : 1;
		}
	}
	return 0;
}

function parseReleaseInfo(value: unknown): ReleaseInfo | null {
	if (typeof value !== "object" || value === null) return null;
	const obj = value as Record<string, unknown>;
	const version = obj.version;
	const downloadUrl = obj.downloadUrl;
	if (typeof version !== "string" || version.length === 0) return null;
	if (typeof downloadUrl !== "string" || downloadUrl.length === 0) return null;
	const info: { -readonly [K in keyof ReleaseInfo]: ReleaseInfo[K] } = { version, downloadUrl };
	if (typeof obj.notes === "string") info.notes = obj.notes;
	if (typeof obj.publishedAt === "string") info.publishedAt = obj.publishedAt;
	return info;
}

/** Defensive decode of the served feed JSON. Unknown shape → empty feed;
 *  a malformed per-channel entry is dropped, the others kept. */
export function parseReleaseFeed(value: unknown): ReleaseFeed {
	if (typeof value !== "object" || value === null) return {};
	const obj = value as Record<string, unknown>;
	const feed: { -readonly [K in keyof ReleaseFeed]: ReleaseFeed[K] } = {};
	const stable = parseReleaseInfo(obj[UpdateChannel.Stable]);
	const beta = parseReleaseInfo(obj[UpdateChannel.Beta]);
	if (stable !== null) feed[UpdateChannel.Stable] = stable;
	if (beta !== null) feed[UpdateChannel.Beta] = beta;
	return feed;
}

/** The release a channel should compare against. Beta users see the
 *  newest of {beta, stable} — a stable release published after the last
 *  beta still surfaces — so a beta user never sits behind a stable bump. */
export function candidateRelease(
	feed: ReleaseFeed,
	channel: UpdateChannel,
): ReleaseInfo | undefined {
	const stable = feed[UpdateChannel.Stable];
	if (channel === UpdateChannel.Stable) return stable;
	const beta = feed[UpdateChannel.Beta];
	if (beta === undefined) return stable;
	if (stable === undefined) return beta;
	return compareVersions(stable.version, beta.version) > 0 ? stable : beta;
}

/** Decide the update status. Total — every input resolves, none throws. */
export function evaluateUpdate(
	currentVersion: string,
	feed: ReleaseFeed,
	channel: UpdateChannel,
	checkedAt: string,
): UpdateCheckResult {
	const latest = candidateRelease(feed, channel);
	if (latest === undefined || parseVersion(latest.version) === null) {
		return { availability: UpdateAvailability.Unknown, channel, currentVersion, checkedAt };
	}
	if (compareVersions(latest.version, currentVersion) > 0) {
		return { availability: UpdateAvailability.Available, channel, currentVersion, latest, checkedAt };
	}
	return { availability: UpdateAvailability.UpToDate, channel, currentVersion, checkedAt };
}
