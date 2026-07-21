import type { WindowEntry } from "@brainstorm-os/protocol/window-types";
import { describe, expect, it } from "vitest";
import { SettingsSection } from "../settings/sections";
import { deriveHelpRoute } from "./derive-help-route";

function w(appId: string, focused: boolean): WindowEntry {
	return {
		id: `${appId}::main`,
		appId,
		appName: appId,
		windowId: "main",
		title: appId,
		monitorId: "primary",
		bounds: { x: 0, y: 0, width: 800, height: 600 },
		state: "normal",
		focused,
		lastFocusedAt: 0,
	} as WindowEntry;
}

describe("deriveHelpRoute", () => {
	it("returns `dashboard` when nothing is focused and no overlay is open", () => {
		expect(deriveHelpRoute({ settingsOpen: false, windows: [] })).toBe("dashboard");
	});

	it("returns `app/<id>` when a single app window is focused", () => {
		const route = deriveHelpRoute({
			settingsOpen: false,
			windows: [w("io.brainstorm.notes", true)],
		});
		expect(route).toBe("app/io.brainstorm.notes");
	});

	it("returns `app/<id>` for whichever window is currently focused (multi-window)", () => {
		const route = deriveHelpRoute({
			settingsOpen: false,
			windows: [
				w("io.brainstorm.notes", false),
				w("io.brainstorm.graph", true),
				w("io.brainstorm.files", false),
			],
		});
		expect(route).toBe("app/io.brainstorm.graph");
	});

	it("returns `dashboard` when windows exist but none are focused", () => {
		const route = deriveHelpRoute({
			settingsOpen: false,
			windows: [w("io.brainstorm.notes", false)],
		});
		expect(route).toBe("dashboard");
	});

	it("returns `settings/<pane>` when Settings is open on a pane", () => {
		const route = deriveHelpRoute({
			settingsOpen: true,
			settingsSection: SettingsSection.Appearance,
			windows: [],
		});
		expect(route).toBe(`settings/${SettingsSection.Appearance}`);
	});

	it("returns `settings` when Settings is open without a pinned pane", () => {
		const route = deriveHelpRoute({
			settingsOpen: true,
			settingsSection: undefined,
			windows: [],
		});
		expect(route).toBe("settings");
	});

	it("Settings wins over a focused app window", () => {
		// The Settings overlay is a modal layer above app windows; when
		// it's open, the user is reading/editing settings — that should
		// be the contextual topic, not the dimmed background app.
		const route = deriveHelpRoute({
			settingsOpen: true,
			settingsSection: SettingsSection.Keyboard,
			windows: [w("io.brainstorm.notes", true)],
		});
		expect(route).toBe(`settings/${SettingsSection.Keyboard}`);
	});

	it("`dashboard` is the fallback for the launcher / switcher / bin (no specific route yet)", () => {
		// These surfaces don't have their own help articles — they fall
		// through to the dashboard home topic via `dashboard`. The
		// resolver returns the home topic for `dashboard`.
		const route = deriveHelpRoute({ settingsOpen: false, windows: [] });
		expect(route).toBe("dashboard");
	});
});
