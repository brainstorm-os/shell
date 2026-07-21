import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeSqlcipherDb } from "./at-rest-fake-driver";
import {
	AtRestMode,
	AtRestProbeReason,
	AtRestReconcileOutcome,
	__resetAtRestProbeForTests,
	describeAtRestMode,
	isAtRestMode,
	probeAtRestMode,
	reconcileAtRestMode,
} from "./at-rest-mode";
import { __setSqlcipherDriverForTests } from "./sqlite";

describe("at-rest mode probe", () => {
	beforeEach(() => {
		__resetAtRestProbeForTests();
		__setSqlcipherDriverForTests(null);
	});
	afterEach(() => {
		__resetAtRestProbeForTests();
		__setSqlcipherDriverForTests(null);
	});

	it("reports Plaintext + BunRuntime under Bun with no injected sqlcipher driver", async () => {
		const result = await probeAtRestMode();
		expect(result.mode).toBe(AtRestMode.Plaintext);
		// `bun` driver is the actual fallback under the Bun test runner;
		// `node` would appear only under stock Node when the SQLCipher
		// resolution explicitly missed.
		expect(result.driverName).toBe("bun");
		expect(result.reason).toBe(AtRestProbeReason.BunRuntime);
	});

	it("reports Encrypted + SqlcipherActive when the injected SQLCipher driver passes the contract probe", async () => {
		__setSqlcipherDriverForTests(
			FakeSqlcipherDb as unknown as new (
				path: string,
			) => unknown as never,
		);
		const result = await probeAtRestMode();
		expect(result.mode).toBe(AtRestMode.Encrypted);
		expect(result.driverName).toBe("sqlcipher");
		expect(result.reason).toBe(AtRestProbeReason.SqlcipherActive);
	});

	it("caches the first probe — concurrent callers share one promise", async () => {
		const [a, b, c] = await Promise.all([probeAtRestMode(), probeAtRestMode(), probeAtRestMode()]);
		expect(a).toBe(b);
		expect(b).toBe(c);
	});

	it("describeAtRestMode produces the canonical boot-log wording", () => {
		expect(
			describeAtRestMode({
				mode: AtRestMode.Encrypted,
				driverName: "sqlcipher",
				reason: AtRestProbeReason.SqlcipherActive,
			}),
		).toMatch(/encrypted at rest/);
		expect(
			describeAtRestMode({
				mode: AtRestMode.Plaintext,
				driverName: "node",
				reason: AtRestProbeReason.DriverUnavailable,
			}),
		).toMatch(/UNENCRYPTED at rest \(3b inactive/);
		expect(
			describeAtRestMode({
				mode: AtRestMode.Plaintext,
				driverName: "bun",
				reason: AtRestProbeReason.BunRuntime,
			}),
		).toMatch(/UNENCRYPTED at rest \(Bun test runtime/);
	});

	it("isAtRestMode validates the enum at the JSON boundary", () => {
		expect(isAtRestMode("encrypted")).toBe(true);
		expect(isAtRestMode("plaintext")).toBe(true);
		expect(isAtRestMode("Encrypted")).toBe(false);
		expect(isAtRestMode("")).toBe(false);
		expect(isAtRestMode(undefined)).toBe(false);
		expect(isAtRestMode(null)).toBe(false);
		expect(isAtRestMode({ mode: "encrypted" })).toBe(false);
	});
});

describe("reconcileAtRestMode", () => {
	const probedEncrypted = {
		mode: AtRestMode.Encrypted,
		driverName: "sqlcipher" as const,
		reason: AtRestProbeReason.SqlcipherActive,
	};
	const probedPlaintext = {
		mode: AtRestMode.Plaintext,
		driverName: "node" as const,
		reason: AtRestProbeReason.DriverUnavailable,
	};

	it("Matches on recorded === probed", () => {
		const r = reconcileAtRestMode(AtRestMode.Encrypted, probedEncrypted, "vlt_test");
		expect(r.outcome).toBe(AtRestReconcileOutcome.Matches);
		expect(r.effectiveMode).toBe(AtRestMode.Encrypted);
	});

	it("UpgradeReady on recorded-plaintext + probed-encrypted", () => {
		const r = reconcileAtRestMode(AtRestMode.Plaintext, probedEncrypted, "vlt_test");
		expect(r.outcome).toBe(AtRestReconcileOutcome.UpgradeReady);
		expect(r.effectiveMode).toBe(AtRestMode.Encrypted);
	});

	it("FirstStamp on undefined recorded — legacy vault", () => {
		const r = reconcileAtRestMode(undefined, probedPlaintext, "vlt_test");
		expect(r.outcome).toBe(AtRestReconcileOutcome.FirstStamp);
		expect(r.effectiveMode).toBe(AtRestMode.Plaintext);
	});

	it("DowngradeRefused throws on recorded-encrypted + probed-plaintext (data-loss guard)", () => {
		expect(() => reconcileAtRestMode(AtRestMode.Encrypted, probedPlaintext, "vlt_test")).toThrow(
			/Refusing to open/,
		);
		expect(() => reconcileAtRestMode(AtRestMode.Encrypted, probedPlaintext, "vlt_test")).toThrow(
			/vlt_test/,
		);
	});

	it("Matches on plaintext recorded + plaintext probed (still no encryption)", () => {
		const r = reconcileAtRestMode(AtRestMode.Plaintext, probedPlaintext, "vlt_test");
		expect(r.outcome).toBe(AtRestReconcileOutcome.Matches);
		expect(r.effectiveMode).toBe(AtRestMode.Plaintext);
	});
});
