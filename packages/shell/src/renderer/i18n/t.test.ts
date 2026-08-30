import { describe, expect, it } from "vitest";
import { applyLocalePack, getActiveLocale, registerTranslations, t, tIfKey } from "./t";

describe("t()", () => {
	it("returns the default-English string for a known key", () => {
		expect(t("shell.actions.save")).toBe("Save");
	});

	it("returns a visible [?key] marker for unknown keys", () => {
		expect(t("nonexistent.key.id")).toBe("[?nonexistent.key.id]");
	});

	it("interpolates {param} placeholders", () => {
		registerTranslations({ "test.greeting": "Hello {name}, you have {count} items" });
		expect(t("test.greeting", { name: "Razor", count: 3 })).toBe("Hello Razor, you have 3 items");
	});

	it("returns the raw message when a required value is missing (FormatJS behavior)", () => {
		registerTranslations({ "test.partial": "Hello {name} and {missing}" });
		expect(t("test.partial", { name: "Razor" })).toBe("Hello {name} and {missing}");
	});

	it("registerTranslations overrides existing keys (used by the pack loader)", () => {
		registerTranslations({ "shell.actions.save": "Sauvegarder" });
		expect(t("shell.actions.save")).toBe("Sauvegarder");
		// Restore for downstream tests
		registerTranslations({ "shell.actions.save": "Save" });
	});

	it("renders literal apostrophes (not ICU quoting) in real catalog strings", () => {
		expect(t("shell.notifications.center.empty")).toBe("You're all caught up.");
	});
});

describe("t() ICU plurals", () => {
	it("selects the singular form at count 1", () => {
		expect(t("shell.settings.security.permissionCount", { count: 1 })).toBe("1 permission");
	});

	it("selects the plural form for other counts", () => {
		expect(t("shell.settings.security.permissionCount", { count: 3 })).toBe("3 permissions");
		expect(t("shell.settings.security.permissionCount", { count: 0 })).toBe("0 permissions");
	});

	it("handles plurals with surrounding text", () => {
		expect(t("shell.settings.network.crash.pendingCount", { count: 1 })).toBe(
			"1 crash report pending submission.",
		);
		expect(t("shell.settings.network.crash.pendingCount", { count: 5 })).toBe(
			"5 crash reports pending submission.",
		);
	});

	it("supports a custom ICU plural message via registerTranslations", () => {
		registerTranslations({
			"test.inbox": "{count, plural, =0 {No unread} one {# unread} other {# unread}}",
		});
		expect(t("test.inbox", { count: 0 })).toBe("No unread");
		expect(t("test.inbox", { count: 1 })).toBe("1 unread");
		expect(t("test.inbox", { count: 9 })).toBe("9 unread");
	});
});

describe("applyLocalePack() — runtime language switch", () => {
	it("overlays the pack on the English base and falls back for missing keys", () => {
		applyLocalePack("es", { "shell.actions.save": "Guardar" });
		expect(getActiveLocale()).toBe("es");
		expect(t("shell.actions.save")).toBe("Guardar");
		// A key the pack omits falls back to the English base.
		expect(t("shell.actions.cancel")).toBe("Cancel");
	});

	it("switching to another language drops the previous pack's overrides", () => {
		applyLocalePack("es", { "shell.actions.save": "Guardar" });
		applyLocalePack("de", { "shell.actions.save": "Speichern" });
		expect(t("shell.actions.save")).toBe("Speichern");
	});

	it("resetting to English restores the source catalog", () => {
		applyLocalePack("es", { "shell.actions.save": "Guardar" });
		applyLocalePack("en", {});
		expect(getActiveLocale()).toBe("en");
		expect(t("shell.actions.save")).toBe("Save");
	});
});

describe("tIfKey()", () => {
	it("translates a known key", () => {
		expect(tIfKey("shell.actions.cancel")).toBe("Cancel");
	});

	it("returns the original value when it is not a known key", () => {
		expect(tIfKey("My Custom App")).toBe("My Custom App");
	});
});
