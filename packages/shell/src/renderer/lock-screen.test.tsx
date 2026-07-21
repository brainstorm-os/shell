// @vitest-environment jsdom
/**
 * Stage 13.8 surface — lock screen.
 *
 * `useVaultLock` mirrors lock state from the `vault:*` bridge (the dashboard
 * gates its whole content tree on it). `<LockScreen>` is the presentational
 * unlock route (only mounted while locked): it relays the PIN to
 * `vaults.unlock` and reflects the `UnlockResult` — wrong-pin → error +
 * cooldown that disables entry, capped → passphrase escape (close vault). The
 * full keystore cycle + idle/sleep + app-window masking ride on the real shell.
 *
 * Submission is **auto** (macOS-style): typing the 6th digit calls
 * `vaults.unlock` directly — there is no explicit Unlock button. The "auto-submits
 * on the 6th digit" + "renders no Unlock submit button" tests pin that design.
 */

import type { LockChangedPayload, UnlockResult } from "@brainstorm-os/protocol/app-lock-wire-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockScreen, useVaultLock } from "./lock-screen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	(window as unknown as { brainstorm?: unknown }).brainstorm = undefined;
	vi.useRealTimers();
});

const boxes = () => [...host.querySelectorAll(".pin-input__box")] as HTMLInputElement[];
const typePin = (digits: string) => {
	for (let i = 0; i < digits.length; i++) {
		const box = boxes()[i];
		if (!box) continue;
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
			setter?.call(box, digits[i]);
			box.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}
};
const unlockButton = () =>
	[...host.querySelectorAll("button")].find((b) => b.textContent === "Unlock") ?? null;

describe("useVaultLock", () => {
	let lockStatus: Mock<() => Promise<{ locked: boolean }>>;
	let emitLock: (payload: LockChangedPayload) => void;

	function Probe() {
		const locked = useVaultLock();
		return <output data-testid="locked">{String(locked)}</output>;
	}
	const lockedText = () => host.querySelector('[data-testid="locked"]')?.textContent;

	beforeEach(() => {
		lockStatus = vi.fn().mockResolvedValue({ locked: true });
		let cb: ((p: LockChangedPayload) => void) | null = null;
		emitLock = (p) => act(() => cb?.(p));
		(window as unknown as { brainstorm: unknown }).brainstorm = {
			vaults: {
				lockStatus,
				onLockChanged: (listener: (p: LockChangedPayload) => void) => {
					cb = listener;
					return () => {
						cb = null;
					};
				},
			},
		};
	});

	it("is undefined until the first lockStatus resolves", () => {
		act(() => root.render(<Probe />));
		// Synchronous first paint, before the lockStatus promise settles: callers
		// render a loader on `undefined` instead of flashing dashboard chrome.
		expect(lockedText()).toBe("undefined");
	});

	it("reflects the initial lockStatus", async () => {
		act(() => root.render(<Probe />));
		await act(async () => {});
		expect(lockedText()).toBe("true");
	});

	it("resolves to false when the lock bridge is missing (stale preload)", async () => {
		(window as unknown as { brainstorm: unknown }).brainstorm = { vaults: {} };
		act(() => root.render(<Probe />));
		await act(async () => {});
		// Must not trap the dashboard behind the loader forever on a stale preload.
		expect(lockedText()).toBe("false");
	});

	it("flips on the app:lock-changed broadcast", async () => {
		lockStatus.mockResolvedValue({ locked: false });
		act(() => root.render(<Probe />));
		await act(async () => {});
		expect(lockedText()).toBe("false");
		emitLock({ locked: true });
		expect(lockedText()).toBe("true");
		emitLock({ locked: false });
		expect(lockedText()).toBe("false");
	});
});

describe("LockScreen", () => {
	let unlock: Mock<(pin: string) => Promise<UnlockResult>>;
	let close: Mock<() => Promise<void>>;

	beforeEach(() => {
		unlock = vi.fn();
		close = vi.fn().mockResolvedValue(undefined);
		(window as unknown as { brainstorm: unknown }).brainstorm = { vaults: { unlock, close } };
	});

	const mount = () => act(() => root.render(<LockScreen />));

	it("renders the 6-box PIN entry", () => {
		mount();
		expect(boxes()).toHaveLength(6);
	});

	it("renders no Unlock submit button", async () => {
		// There is no explicit submit button — PIN auto-submits, so a disabled-forever
		// Unlock button would be dead weight.
		unlock.mockResolvedValue({ ok: true });
		mount();
		expect(unlockButton()).toBeNull();
		await act(async () => {
			typePin("123456");
		});
		expect(unlockButton()).toBeNull();
	});

	it("auto-submits the typed PIN to vaults.unlock on the 6th digit", async () => {
		unlock.mockResolvedValue({ ok: true });
		mount();
		await act(async () => {
			typePin("123456");
		});
		expect(unlock).toHaveBeenCalledWith("123456");
	});

	it("clears the PIN and shows an error after a failed unlock, then accepts a retry", async () => {
		vi.useFakeTimers();
		unlock.mockResolvedValue({ ok: false, reason: "wrong-pin", failedAttempts: 1, cooldownMs: 0 });
		mount();
		await act(async () => {
			typePin("000000");
		});
		expect(unlock).toHaveBeenCalledWith("000000");
		expect(unlock).toHaveBeenCalledTimes(1);
		// PIN cleared → boxes empty, ready for another attempt.
		expect(boxes().every((b) => b.value === "")).toBe(true);
		expect(host.querySelector(".lock-screen__error")).not.toBeNull();
		// No cooldown gate → the user can type again immediately, which re-submits.
		await act(async () => {
			typePin("123456");
		});
		expect(unlock).toHaveBeenCalledTimes(2);
		expect(unlock).toHaveBeenLastCalledWith("123456");
	});

	it("shows a cooldown and disables entry after a wrong PIN, then re-enables", async () => {
		vi.useFakeTimers();
		unlock.mockResolvedValue({ ok: false, reason: "wrong-pin", failedAttempts: 3, cooldownMs: 5000 });
		mount();
		await act(async () => {
			typePin("000000");
		});
		expect(host.querySelector(".lock-screen__cooldown")).not.toBeNull();
		expect(boxes()[0]?.disabled).toBe(true);
		await act(async () => {
			vi.advanceTimersByTime(5000);
		});
		expect(boxes()[0]?.disabled).toBe(false);
		expect(host.querySelector(".lock-screen__cooldown")).toBeNull();
	});

	it("replaces PIN entry with the passphrase escape once capped", async () => {
		unlock.mockResolvedValue({ ok: false, reason: "capped", failedAttempts: 7, cooldownMs: 0 });
		mount();
		await act(async () => {
			typePin("000000");
		});
		expect(boxes()).toHaveLength(0);
		const closeBtn = [...host.querySelectorAll("button")].find(
			(b) => b.textContent === "Close vault",
		);
		expect(closeBtn).toBeDefined();
		act(() => closeBtn?.click());
		expect(close).toHaveBeenCalledTimes(1);
	});
});
