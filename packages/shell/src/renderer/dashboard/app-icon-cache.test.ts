/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import {
	APP_ICON_CACHE_KEY,
	appHasIcon,
	appIconVersion,
	appIconsKnown,
	resolveAppIconSrc,
	setAppIcons,
} from "./app-icon-cache";

describe("app-icon cache", () => {
	// Module state starts cold (nothing persisted at import) — this case can
	// only be observed before the first `setAppIcons`, so it runs first.
	it("renders optimistically before the first authoritative list", () => {
		expect(appIconsKnown()).toBe(false);
		expect(resolveAppIconSrc("com.example.app")).toBe("brainstorm://app-icon/com.example.app");
	});

	it("resolves a versioned, cacheable URL for an app that ships an icon", () => {
		const changed = setAppIcons([{ id: "com.example.app", hasIcon: true, version: "1.2.0" }]);
		expect(changed).toBe(true);
		expect(appIconsKnown()).toBe(true);
		expect(appHasIcon("com.example.app")).toBe(true);
		expect(appIconVersion("com.example.app")).toBe("1.2.0");
		expect(resolveAppIconSrc("com.example.app")).toBe(
			"brainstorm://app-icon/com.example.app?v=1.2.0",
		);
	});

	it("suppresses the request for a known icon-less app", () => {
		setAppIcons([{ id: "com.example.plain", hasIcon: false, version: "1.0.0" }]);
		expect(appHasIcon("com.example.plain")).toBe(false);
		expect(resolveAppIconSrc("com.example.plain")).toBeNull();
	});

	it("persists the version map to localStorage", () => {
		setAppIcons([{ id: "com.example.persist", hasIcon: true, version: "3.0.0" }]);
		const raw = window.localStorage.getItem(APP_ICON_CACHE_KEY);
		expect(raw).not.toBeNull();
		expect(JSON.parse(raw ?? "{}")).toEqual({ "com.example.persist": "3.0.0" });
	});

	it("reports no change when the list is identical", () => {
		setAppIcons([{ id: "com.example.same", hasIcon: true, version: "1.0.0" }]);
		const changed = setAppIcons([{ id: "com.example.same", hasIcon: true, version: "1.0.0" }]);
		expect(changed).toBe(false);
	});

	// POLISH-LAY-8 — the widget header wants a per-install-epoch retry (F-380)
	// AND the icon-less suppression. It used to hand-build its own URL to get
	// the first, and so lost the second.
	it("appends the caller's apps-changed epoch to a versioned URL", () => {
		setAppIcons([{ id: "com.example.widget", hasIcon: true, version: "1.0.0" }]);
		expect(resolveAppIconSrc("com.example.widget", 3)).toBe(
			"brainstorm://app-icon/com.example.widget?v=1.0.0&e=3",
		);
	});

	it("suppresses an epoch request for a known icon-less app too", () => {
		setAppIcons([{ id: "com.example.noart", hasIcon: false, version: "1.0.0" }]);
		expect(resolveAppIconSrc("com.example.noart", 3)).toBeNull();
	});

	it("reports a change when a version bumps", () => {
		setAppIcons([{ id: "com.example.bump", hasIcon: true, version: "1.0.0" }]);
		const changed = setAppIcons([{ id: "com.example.bump", hasIcon: true, version: "2.0.0" }]);
		expect(changed).toBe(true);
		expect(resolveAppIconSrc("com.example.bump")).toBe(
			"brainstorm://app-icon/com.example.bump?v=2.0.0",
		);
	});
});
