import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppLockPin } from "../credentials/app-lock-pin";
import { removeTestDir } from "../test-support/remove-test-dir";
import { APP_LOCK_ATTEMPT_CAP } from "./app-lock-policy";
import {
	AppLockMode,
	VaultSession,
	appLockModeForBackend,
	closeActiveVaultSession,
	getActiveVaultSession,
	isVaultLocked,
	lockActiveVault,
	lockOnBootIfPinSet,
	onActiveVaultSessionChanged,
	resetAppLockStateForTests,
	setActiveVaultSession,
	unlockActiveVault,
} from "./session";

describe("app-lock — lock/unlock state machine (13.8b)", () => {
	let vaultDir: string;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-applock-"));
	});

	afterEach(async () => {
		vi.useRealTimers();
		resetAppLockStateForTests();
		closeActiveVaultSession();
		await removeTestDir(vaultDir);
	});

	it("maps backends to modes (passphrase → soft, others → hard)", () => {
		expect(appLockModeForBackend("passphrase")).toBe(AppLockMode.Soft);
		expect(appLockModeForBackend("insecure-dev")).toBe(AppLockMode.Hard);
		expect(appLockModeForBackend("keychain-macos")).toBe(AppLockMode.Hard);
	});

	it("close + hard-lock notify active-session subscribers (Browser-10 jar teardown)", async () => {
		const session = await VaultSession.create({
			vaultId: "vlt_notify",
			vaultPath: vaultDir,
			forceInsecure: true,
		});
		const seen: Array<string | null> = [];
		const unsubscribe = onActiveVaultSessionChanged((s) => seen.push(s?.vaultId ?? null));
		setActiveVaultSession(session);
		await setAppLockPin(session.backend, "vlt_notify", "1234");
		// A hard-lock routes through closeActiveVaultSession — it MUST still fire
		// the teardown notification (else the cookie jar never clears the live
		// web session / drops its listener while "locked").
		lockActiveVault({ forceInsecure: true });
		unsubscribe();
		expect(seen).toEqual(["vlt_notify", null]);
	});

	it("hard-lock disposes the session, then unlock(pin) re-opens it", async () => {
		const session = await VaultSession.create({
			vaultId: "vlt_hard",
			vaultPath: vaultDir,
			forceInsecure: true,
		});
		const fingerprint = session.identity.fingerprint;
		setActiveVaultSession(session);
		await setAppLockPin(session.backend, "vlt_hard", "1234");

		const mode = lockActiveVault({ forceInsecure: true });
		expect(mode).toBe(AppLockMode.Hard);
		expect(isVaultLocked()).toBe(true);
		// Hard-lock zeroed + disposed the session — the broker sees no active vault.
		expect(getActiveVaultSession()).toBeNull();

		const wrong = await unlockActiveVault("9999");
		expect(wrong).toEqual({ ok: false, reason: "wrong-pin", failedAttempts: 1, cooldownMs: 0 });
		expect(isVaultLocked()).toBe(true);
		expect(getActiveVaultSession()).toBeNull();

		const right = await unlockActiveVault("1234");
		expect(right).toEqual({ ok: true });
		expect(isVaultLocked()).toBe(false);
		// Re-opened: a fresh session with the same identity, fully usable.
		const reopened = getActiveVaultSession();
		expect(reopened).not.toBeNull();
		expect(reopened?.identity.fingerprint).toBe(fingerprint);
		expect(() => reopened?.signPayload(new Uint8Array([1, 2, 3]))).not.toThrow();
	});

	it("caps the PIN after the attempt cap (then refuses outright)", async () => {
		const session = await VaultSession.create({
			vaultId: "vlt_cap",
			vaultPath: vaultDir,
			forceInsecure: true,
		});
		setActiveVaultSession(session);
		await setAppLockPin(session.backend, "vlt_cap", "1234");
		lockActiveVault({ forceInsecure: true });

		// The escalating cooldown is enforced main-side, so space the attempts out
		// past each rung (fake clock) — otherwise attempts 4+ are gated and never
		// reach the cap.
		vi.useFakeTimers();
		vi.setSystemTime(0);
		let last = await unlockActiveVault("0000");
		for (let i = 2; i <= APP_LOCK_ATTEMPT_CAP; i++) {
			vi.setSystemTime(i * 60_000);
			last = await unlockActiveVault("0000");
		}
		expect(last).toMatchObject({ ok: false, reason: "capped" });
		// Even the correct PIN is refused while capped — passphrase re-auth only.
		const stillCapped = await unlockActiveVault("1234");
		expect(stillCapped).toMatchObject({ ok: false, reason: "capped" });
		expect(isVaultLocked()).toBe(true);
	});

	it("soft-lock keeps the same session resident; unlock(pin) just clears the flag", async () => {
		const session = await VaultSession.create({
			vaultId: "vlt_soft",
			vaultPath: vaultDir,
			skipKeyring: true,
			passphrase: { passphrase: "correct horse battery staple", kdf: { m: 8, t: 1, p: 1 } },
		});
		expect(session.backend.name).toBe("passphrase");
		setActiveVaultSession(session);
		await setAppLockPin(session.backend, "vlt_soft", "4321");

		const mode = lockActiveVault();
		expect(mode).toBe(AppLockMode.Soft);
		expect(isVaultLocked()).toBe(true);
		// Soft-lock keeps the very same session instance (key resident).
		expect(getActiveVaultSession()).toBe(session);
		expect(session.isLocked()).toBe(true);

		const wrong = await unlockActiveVault("0000");
		expect(wrong.ok).toBe(false);
		expect(session.isLocked()).toBe(true);

		const right = await unlockActiveVault("4321");
		expect(right).toEqual({ ok: true });
		expect(session.isLocked()).toBe(false);
		expect(getActiveVaultSession()).toBe(session);
	});

	it("boots LOCKED when the active vault has a PIN (cold-launch gate)", async () => {
		const session = await VaultSession.create({
			vaultId: "vlt_boot",
			vaultPath: vaultDir,
			forceInsecure: true,
		});
		setActiveVaultSession(session);
		await setAppLockPin(session.backend, "vlt_boot", "1234");

		const mode = await lockOnBootIfPinSet({ forceInsecure: true });
		expect(mode).toBe(AppLockMode.Hard);
		expect(isVaultLocked()).toBe(true);
		// Hard-lock disposed the session — the broker fails closed until unlock.
		expect(getActiveVaultSession()).toBeNull();

		const right = await unlockActiveVault("1234");
		expect(right).toEqual({ ok: true });
		expect(isVaultLocked()).toBe(false);
	});

	it("boots UNLOCKED when the active vault has no PIN", async () => {
		const session = await VaultSession.create({
			vaultId: "vlt_nopin",
			vaultPath: vaultDir,
			forceInsecure: true,
		});
		setActiveVaultSession(session);

		const mode = await lockOnBootIfPinSet();
		expect(mode).toBeNull();
		expect(isVaultLocked()).toBe(false);
		expect(getActiveVaultSession()).toBe(session);
	});

	it("unlock with no lock engaged reports not-locked", async () => {
		expect(await unlockActiveVault("1234")).toEqual({
			ok: false,
			reason: "not-locked",
			failedAttempts: 0,
			cooldownMs: 0,
		});
	});
});
