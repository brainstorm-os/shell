/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it } from "vitest";
import { APP_LOCK_OVERLAY_ID, setAppLockOverlay } from "./app-lock-overlay";

afterEach(() => {
	document.getElementById(APP_LOCK_OVERLAY_ID)?.remove();
});

describe("setAppLockOverlay", () => {
	it("paints an opaque, viewport-fixed, interaction-blocking overlay on lock", () => {
		setAppLockOverlay(true);
		const overlay = document.getElementById(APP_LOCK_OVERLAY_ID);
		expect(overlay).not.toBeNull();
		expect(overlay?.parentElement).toBe(document.documentElement);
		expect(overlay?.style.position).toBe("fixed");
		expect(overlay?.style.zIndex).toBe("2147483647");
		expect(overlay?.style.pointerEvents).toBe("auto");
		// An opaque background (not a see-through fallback) is the whole point.
		expect(overlay?.style.background).not.toBe("");
		expect(overlay?.getAttribute("aria-hidden")).toBe("true");
	});

	it("removes the overlay on unlock", () => {
		setAppLockOverlay(true);
		setAppLockOverlay(false);
		expect(document.getElementById(APP_LOCK_OVERLAY_ID)).toBeNull();
	});

	it("never stacks overlays on a repeated lock", () => {
		setAppLockOverlay(true);
		setAppLockOverlay(true);
		expect(document.querySelectorAll(`#${APP_LOCK_OVERLAY_ID}`).length).toBe(1);
	});

	it("survives a body re-render (anchored on documentElement)", () => {
		setAppLockOverlay(true);
		document.body.replaceChildren(); // app re-renders its root
		expect(document.getElementById(APP_LOCK_OVERLAY_ID)).not.toBeNull();
	});

	it("no-ops without a document", () => {
		expect(() => setAppLockOverlay(true, undefined)).not.toThrow();
	});
});
