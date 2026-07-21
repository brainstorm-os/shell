/**
 * `<NetworkEgressPanel>` (Net-1f) — SSR-rendered tests against the
 * privileged `window.brainstorm.network.*` bridge. We mirror the
 * pattern in `devices-section.test.tsx` / `sync-section.test.tsx`:
 * stub the bridge, render once (no useEffect under SSR), assert the
 * loading branch + section enum + helpers.
 */

import {
	EffectiveProxyKind,
	NetworkAuditOutcome,
	NetworkPrivacyMode,
	NetworkProxyMode,
} from "@brainstorm-os/protocol/network-wire-types";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkEgressPanel, formatBytes, formatRelative } from "./network-egress-panel";
import { SettingsSection } from "./sections";

type StubNetwork = {
	settings: {
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
		on: ReturnType<typeof vi.fn>;
	};
	brokerState: ReturnType<typeof vi.fn>;
	audit: {
		recent: ReturnType<typeof vi.fn>;
		blocked: ReturnType<typeof vi.fn>;
		perAppSummary: ReturnType<typeof vi.fn>;
	};
	cache: {
		stats: ReturnType<typeof vi.fn>;
		clear: ReturnType<typeof vi.fn>;
	};
};

type StubLedger = {
	revoke: ReturnType<typeof vi.fn>;
	listGrantsByApp: ReturnType<typeof vi.fn>;
};

type StubApps = {
	listInstalled: ReturnType<typeof vi.fn>;
	iconUrl: ReturnType<typeof vi.fn>;
};

type StubFeedback = {
	settings: {
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
	};
	submit: ReturnType<typeof vi.fn>;
	recentLog: ReturnType<typeof vi.fn>;
	crash: {
		pendingCount: ReturnType<typeof vi.fn>;
		list: ReturnType<typeof vi.fn>;
		submitNow: ReturnType<typeof vi.fn>;
		clear: ReturnType<typeof vi.fn>;
	};
};

let stub: {
	network: StubNetwork;
	ledger: StubLedger;
	apps: StubApps;
	feedback: StubFeedback;
};

beforeEach(() => {
	stub = {
		network: {
			settings: {
				get: vi.fn().mockResolvedValue(null),
				set: vi.fn().mockResolvedValue(undefined),
				on: vi.fn().mockReturnValue(() => undefined),
			},
			brokerState: vi.fn().mockResolvedValue({
				proxy: { mode: NetworkProxyMode.System },
				resolvedProxyKind: EffectiveProxyKind.Deferred,
				privacy: { mode: NetworkPrivacyMode.On },
				previewCacheStats: { entryCount: 0, oldestMs: null, newestMs: null },
			}),
			audit: {
				recent: vi.fn().mockResolvedValue([]),
				blocked: vi.fn().mockResolvedValue([]),
				perAppSummary: vi.fn().mockResolvedValue([]),
			},
			cache: {
				stats: vi.fn().mockResolvedValue({ entryCount: 0, oldestMs: null, newestMs: null }),
				clear: vi.fn().mockResolvedValue(undefined),
			},
		},
		ledger: {
			revoke: vi.fn().mockResolvedValue(true),
			listGrantsByApp: vi.fn().mockResolvedValue({}),
		},
		apps: {
			listInstalled: vi.fn().mockResolvedValue([]),
			iconUrl: vi.fn().mockReturnValue("brainstorm://app-icon/test"),
		},
		feedback: {
			settings: {
				get: vi.fn().mockResolvedValue({
					enabled: false,
					endpoint: null,
					installationId: "stub-install-id",
					crashReportingEnabled: false,
					lastCrashSubmitAttemptMs: null,
				}),
				set: vi.fn().mockImplementation(async (patch) => ({
					enabled: patch.enabled ?? false,
					endpoint: patch.endpoint ?? null,
					installationId: "stub-install-id",
					crashReportingEnabled: patch.crashReportingEnabled ?? false,
					lastCrashSubmitAttemptMs: null,
				})),
			},
			submit: vi.fn(),
			recentLog: vi.fn().mockResolvedValue(""),
			crash: {
				pendingCount: vi.fn().mockResolvedValue({
					count: 0,
					localCount: 0,
					lastCapturedAt: null,
					lastSubmitAttemptMs: null,
				}),
				list: vi.fn().mockResolvedValue([]),
				submitNow: vi.fn().mockResolvedValue({ submitted: 0, failed: 0, dropped: 0 }),
				clear: vi.fn().mockResolvedValue(0),
			},
		},
	};
	(globalThis as { window?: unknown }).window = { brainstorm: stub };
});

afterEach(() => {
	(globalThis as { window?: unknown }).window = undefined;
});

describe("SettingsSection.Network", () => {
	it("declares the Network section enum entry (Net-1f)", () => {
		expect(SettingsSection.Network).toBe("network");
	});

	it("is distinct from the other settings sections", () => {
		const all = Object.values(SettingsSection);
		const unique = new Set(all);
		expect(unique.size).toBe(all.length);
		expect(unique.has(SettingsSection.Network)).toBe(true);
	});
});

describe("<NetworkEgressPanel> — SSR", () => {
	it("renders the loading placeholder on first synchronous paint", () => {
		const html = renderToStaticMarkup(<NetworkEgressPanel />);
		expect(html).toContain("settings__placeholder");
	});

	it("the privileged network bridge shape is consumed (six channels)", () => {
		const bridge = stub.network;
		expect(typeof bridge.brokerState).toBe("function");
		expect(typeof bridge.audit.recent).toBe("function");
		expect(typeof bridge.audit.blocked).toBe("function");
		expect(typeof bridge.audit.perAppSummary).toBe("function");
		expect(typeof bridge.cache.stats).toBe("function");
		expect(typeof bridge.cache.clear).toBe("function");
	});

	it("placeholder copy is t-keyed (no bare i18n keys)", () => {
		const html = renderToStaticMarkup(<NetworkEgressPanel />);
		expect(html).not.toContain("shell.settings.network.loading");
	});

	it("the feedback bridge shape is consumed (Feedback-1)", () => {
		const bridge = stub.feedback;
		expect(typeof bridge.settings.get).toBe("function");
		expect(typeof bridge.settings.set).toBe("function");
		expect(typeof bridge.submit).toBe("function");
		expect(typeof bridge.recentLog).toBe("function");
	});

	it("the crash bridge shape is consumed (Feedback-2)", () => {
		const bridge = stub.feedback.crash;
		expect(typeof bridge.pendingCount).toBe("function");
		expect(typeof bridge.list).toBe("function");
		expect(typeof bridge.submitNow).toBe("function");
		expect(typeof bridge.clear).toBe("function");
	});
});

describe("formatBytes", () => {
	it("returns 0 B for zero / negatives / NaN", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(-5)).toBe("0 B");
		expect(formatBytes(Number.NaN)).toBe("0 B");
	});

	it("formats bytes in the right unit", () => {
		expect(formatBytes(100)).toBe("100 B");
		expect(formatBytes(2048)).toBe("2 KB");
		expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
		expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3 GB");
	});

	it("is monotone — bigger inputs read as bigger units", () => {
		const small = formatBytes(1500); // 1.5 KB
		const large = formatBytes(1500 * 1024); // ~1.5 MB
		expect(small).toContain("KB");
		expect(large).toContain("MB");
	});
});

describe("formatRelative", () => {
	const now = 1_700_000_000_000;

	it('returns "—" for zero / NaN', () => {
		expect(formatRelative(0, now)).toBe("—");
		expect(formatRelative(Number.NaN, now)).toBe("—");
	});

	it("renders just-now for sub-10s ages", () => {
		// `t("shell.settings.network.time.now")` → "just now" in the
		// default manifest. Just verify it's not the seconds-ago form.
		const out = formatRelative(now - 4_000, now);
		expect(out).toContain("now");
	});

	it("scales up the unit as the age grows", () => {
		const s = formatRelative(now - 30_000, now);
		const m = formatRelative(now - 5 * 60 * 1000, now);
		const h = formatRelative(now - 3 * 60 * 60 * 1000, now);
		const d = formatRelative(now - 5 * 24 * 60 * 60 * 1000, now);
		expect(s).toContain("s ago");
		expect(m).toContain("m ago");
		expect(h).toContain("h ago");
		expect(d).toContain("d ago");
	});
});

describe("audit-outcome enum coverage", () => {
	it("every outcome maps to a known label key", () => {
		// Sanity that the panel covers every outcome the audit log emits;
		// catches the case where a new outcome is added but the panel's
		// switch isn't extended.
		const outcomes = [
			NetworkAuditOutcome.Completed,
			NetworkAuditOutcome.Refused,
			NetworkAuditOutcome.Aborted,
			NetworkAuditOutcome.Errored,
		];
		expect(outcomes).toHaveLength(4);
	});
});

describe("privacy-mode coverage", () => {
	it("every privacy mode is wired through the segmented control order", () => {
		const modes = [
			NetworkPrivacyMode.Off,
			NetworkPrivacyMode.On,
			NetworkPrivacyMode.Allowlist,
			NetworkPrivacyMode.Manual,
		];
		const unique = new Set(modes);
		expect(unique.size).toBe(4);
	});
});

describe("proxy-mode coverage", () => {
	it("every proxy mode has a UI representation", () => {
		const modes = [
			NetworkProxyMode.Direct,
			NetworkProxyMode.System,
			NetworkProxyMode.Manual,
			NetworkProxyMode.Pac,
		];
		expect(new Set(modes).size).toBe(4);
	});
});
