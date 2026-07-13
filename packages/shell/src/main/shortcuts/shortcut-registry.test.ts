import { describe, expect, it } from "vitest";
import {
	DEFAULT_SHELL_SHORTCUTS,
	ShortcutRegistry,
	normalizeChord,
	shellChordSet,
} from "./shortcut-registry";

describe("normalizeChord", () => {
	it("lowercases keys + alphabetizes modifiers", () => {
		expect(normalizeChord("Shift+Ctrl+K")).toBe("ctrl+shift+k");
		expect(normalizeChord("Ctrl+Shift+K")).toBe("ctrl+shift+k");
		expect(normalizeChord("Cmd+B")).toBe("cmd+b");
	});

	it("handles a key alone (no modifiers)", () => {
		expect(normalizeChord("?")).toBe("?");
	});

	it("treats whitespace gracefully", () => {
		expect(normalizeChord(" Ctrl + Shift + K ")).toBe("ctrl+shift+k");
	});

	it("returns '' for an empty chord", () => {
		expect(normalizeChord("")).toBe("");
	});
});

describe("ShortcutRegistry — shell layer", () => {
	it("registers the default shell shortcut set", () => {
		const reg = new ShortcutRegistry();
		reg.registerShell();
		const ids = reg.listAll().map((r) => r.action.id);
		for (const expected of DEFAULT_SHELL_SHORTCUTS.map((s) => s.id)) {
			expect(ids).toContain(expected);
		}
	});

	it("resolves an unbound action id as null", () => {
		const reg = new ShortcutRegistry();
		expect(reg.resolve("shell/nonsense")).toBeNull();
	});

	it("default-chord becomes the resolved chord with source='default'", () => {
		const reg = new ShortcutRegistry();
		reg.registerShell();
		const resolved = reg.resolve("shell/launcher");
		expect(resolved?.chord).toBe("CmdOrCtrl+K");
		expect(resolved?.source).toBe("default");
	});

	it("overrideOne replaces the chord with source='user-override'", () => {
		const reg = new ShortcutRegistry();
		reg.registerShell();
		reg.overrideOne("shell/launcher", "CmdOrCtrl+P");
		const resolved = reg.resolve("shell/launcher");
		expect(resolved?.chord).toBe("CmdOrCtrl+P");
		expect(resolved?.source).toBe("user-override");
	});

	it("overrideOne(null) clears the chord; source='cleared'", () => {
		const reg = new ShortcutRegistry();
		reg.registerShell();
		reg.overrideOne("shell/launcher", null);
		const resolved = reg.resolve("shell/launcher");
		expect(resolved?.chord).toBeNull();
		expect(resolved?.source).toBe("cleared");
	});

	it("resetOverride reverts to the default", () => {
		const reg = new ShortcutRegistry();
		reg.registerShell();
		reg.overrideOne("shell/launcher", "CmdOrCtrl+P");
		reg.resetOverride("shell/launcher");
		expect(reg.resolve("shell/launcher")?.chord).toBe("CmdOrCtrl+K");
	});

	it("applyOverrides bulk-loads user-stored overrides", () => {
		const reg = new ShortcutRegistry();
		reg.registerShell();
		reg.applyOverrides([
			{ id: "shell/launcher", chord: "CmdOrCtrl+P" },
			{ id: "shell/settings", chord: null },
		]);
		expect(reg.resolve("shell/launcher")?.chord).toBe("CmdOrCtrl+P");
		expect(reg.resolve("shell/settings")?.chord).toBeNull();
	});

	it("snapshotOverrides round-trips through applyOverrides", () => {
		const reg = new ShortcutRegistry();
		reg.registerShell();
		reg.overrideOne("shell/launcher", "CmdOrCtrl+P");
		reg.overrideOne("shell/settings", null);
		const snapshot = reg.snapshotOverrides();
		const next = new ShortcutRegistry();
		next.registerShell();
		next.applyOverrides(snapshot);
		expect(next.resolve("shell/launcher")?.chord).toBe("CmdOrCtrl+P");
		expect(next.resolve("shell/settings")?.chord).toBeNull();
	});
});

describe("ShortcutRegistry — app layer", () => {
	it("namespaces app actions by `<app-id>/<id>`", () => {
		const reg = new ShortcutRegistry();
		reg.registerApp("io.example.editor", [
			{ id: "save", default: "CmdOrCtrl+S", label: "Save" },
			{ id: "format-bold", default: "CmdOrCtrl+B", label: "Bold" },
		]);
		expect(reg.resolve("io.example.editor/save")?.chord).toBe("CmdOrCtrl+S");
		expect(reg.resolve("io.example.editor/format-bold")?.chord).toBe("CmdOrCtrl+B");
	});

	it("registerApp replaces a prior set for the same app id", () => {
		const reg = new ShortcutRegistry();
		reg.registerApp("io.example.editor", [{ id: "save", default: "Ctrl+S", label: "Save" }]);
		reg.registerApp("io.example.editor", [{ id: "find", default: "Ctrl+F", label: "Find" }]);
		expect(reg.resolve("io.example.editor/save")).toBeNull();
		expect(reg.resolve("io.example.editor/find")?.chord).toBe("Ctrl+F");
	});

	it("unregisterApp removes its actions and overrides", () => {
		const reg = new ShortcutRegistry();
		reg.registerApp("io.example.editor", [{ id: "save", default: "Ctrl+S", label: "Save" }]);
		reg.overrideOne("io.example.editor/save", "Ctrl+Shift+S");
		reg.unregisterApp("io.example.editor");
		expect(reg.resolve("io.example.editor/save")).toBeNull();
		expect(
			reg.snapshotOverrides().find((o) => o.id.startsWith("io.example.editor/")),
		).toBeUndefined();
	});
});

describe("ShortcutRegistry — conflicts + lookup", () => {
	it("findByChord normalizes before matching", () => {
		const reg = new ShortcutRegistry();
		reg.registerShell();
		reg.registerApp("io.example.editor", [{ id: "bold", default: "Cmd+B", label: "Bold" }]);
		const matches = reg.findByChord("B+Cmd");
		expect(matches.map((m) => m.action.id)).toEqual(["io.example.editor/bold"]);
	});

	it("conflicts reports cross-layer collisions", () => {
		const reg = new ShortcutRegistry();
		reg.registerShell();
		// shell/close-window default is CmdOrCtrl+W — give an app the same chord.
		reg.registerApp("io.example.editor", [
			{ id: "close-doc", default: "CmdOrCtrl+W", label: "Close Document" },
		]);
		const conflicts = reg.conflicts();
		const collision = conflicts.find((c) => c.chord === "cmdorctrl+w");
		expect(collision).toBeDefined();
		expect(collision?.bindings.map((b) => b.id).sort()).toEqual([
			"io.example.editor/close-doc",
			"shell/close-window",
		]);
	});

	it("user-override that hits an existing chord creates a conflict", () => {
		const reg = new ShortcutRegistry();
		reg.registerShell();
		// Override shell/launcher to use the same chord as shell/quit.
		reg.overrideOne("shell/launcher", "CmdOrCtrl+Q");
		const conflicts = reg.conflicts();
		const collision = conflicts.find((c) => c.chord === "cmdorctrl+q");
		expect(collision?.bindings.length).toBe(2);
	});

	it("cleared chord does NOT participate in conflicts", () => {
		const reg = new ShortcutRegistry();
		reg.registerShell();
		reg.overrideOne("shell/quit", null);
		reg.registerApp("io.example.editor", [
			{ id: "quit", default: "CmdOrCtrl+Q", label: "Quit Editor" },
		]);
		const conflicts = reg.conflicts();
		expect(conflicts.find((c) => c.chord === "cmdorctrl+q")).toBeUndefined();
	});

	it("listAll returns bindings sorted by id", () => {
		const reg = new ShortcutRegistry();
		reg.registerApp("z.example", [{ id: "a", default: "Z", label: "Z" }]);
		reg.registerApp("a.example", [{ id: "b", default: "A", label: "A" }]);
		const ids = reg.listAll().map((r) => r.action.id);
		expect(ids).toEqual([...ids].sort());
	});

	it("registerApp records shadowsShell on the action when set", () => {
		const reg = new ShortcutRegistry();
		reg.registerApp("io.example.app", [
			{ id: "palette", default: "Mod+Shift+P", label: "Palette", shadowsShell: true },
			{ id: "save", default: "Mod+S", label: "Save" },
		]);
		expect(reg.resolve("io.example.app/palette")?.action.shadowsShell).toBe(true);
		// Default-omit when not set (not `false`); keeps the field optional.
		expect(reg.resolve("io.example.app/save")?.action.shadowsShell).toBeUndefined();
	});
});

describe("ShortcutRegistry — dynamic + active scope (6.10c)", () => {
	it("registerAppDynamic adds bindings with dynamic:true and the app namespace", () => {
		const reg = new ShortcutRegistry();
		reg.registerAppDynamic("io.example.app", [{ id: "save", default: "Mod+S", label: "Save" }]);
		const resolved = reg.resolve("io.example.app/save");
		expect(resolved?.action.layer).toBe("app");
		expect(resolved?.action.appId).toBe("io.example.app");
		expect(resolved?.action.dynamic).toBe(true);
		expect(resolved?.chord).toBe("Mod+S");
	});

	it("dynamic shadows a static manifest entry with the same id", () => {
		const reg = new ShortcutRegistry();
		reg.registerApp("io.example.app", [{ id: "save", default: "Mod+S", label: "Save (static)" }]);
		reg.registerAppDynamic("io.example.app", [
			{ id: "save", default: "Mod+Alt+S", label: "Save (dynamic)" },
		]);
		const resolved = reg.resolve("io.example.app/save");
		expect(resolved?.action.label).toBe("Save (dynamic)");
		expect(resolved?.action.dynamic).toBe(true);
		expect(resolved?.chord).toBe("Mod+Alt+S");
		// listAll should still list exactly one binding for this id
		// (no duplicate from the shadowed static).
		const matches = reg.listAll().filter((b) => b.action.id === "io.example.app/save");
		expect(matches).toHaveLength(1);
	});

	it("re-calling registerAppDynamic replaces the same id (last-write-wins)", () => {
		const reg = new ShortcutRegistry();
		reg.registerAppDynamic("io.example.app", [{ id: "save", default: "Mod+S", label: "v1" }]);
		reg.registerAppDynamic("io.example.app", [{ id: "save", default: "Mod+Shift+S", label: "v2" }]);
		const resolved = reg.resolve("io.example.app/save");
		expect(resolved?.action.label).toBe("v2");
		expect(resolved?.chord).toBe("Mod+Shift+S");
	});

	it("unregisterAppDynamic removes specific ids; unknown ids are silent no-ops", () => {
		const reg = new ShortcutRegistry();
		reg.registerAppDynamic("io.example.app", [
			{ id: "save", default: "Mod+S", label: "Save" },
			{ id: "find", default: "Mod+F", label: "Find" },
		]);
		reg.unregisterAppDynamic("io.example.app", ["save", "nonexistent"]);
		expect(reg.resolve("io.example.app/save")).toBeNull();
		expect(reg.resolve("io.example.app/find")).not.toBeNull();
	});

	it("unregisterAllDynamic clears only the app's dynamic entries (static survives)", () => {
		const reg = new ShortcutRegistry();
		reg.registerApp("io.example.app", [{ id: "static-save", default: "Mod+S", label: "Static" }]);
		reg.registerAppDynamic("io.example.app", [
			{ id: "dyn-find", default: "Mod+F", label: "Dynamic" },
		]);
		reg.registerAppDynamic("other.app", [{ id: "dyn", default: "Mod+G", label: "Other" }]);
		reg.unregisterAllDynamic("io.example.app");
		expect(reg.resolve("io.example.app/static-save")).not.toBeNull();
		expect(reg.resolve("io.example.app/dyn-find")).toBeNull();
		expect(reg.resolve("other.app/dyn")).not.toBeNull();
	});

	it("unregisterApp clears static + dynamic + active scope for the app", () => {
		const reg = new ShortcutRegistry();
		reg.registerApp("io.example.app", [{ id: "static", default: "Mod+S", label: "Static" }]);
		reg.registerAppDynamic("io.example.app", [{ id: "dyn", default: "Mod+F", label: "Dynamic" }]);
		reg.setActiveScope("io.example.app", "editor");
		reg.unregisterApp("io.example.app");
		expect(reg.resolve("io.example.app/static")).toBeNull();
		expect(reg.resolve("io.example.app/dyn")).toBeNull();
		expect(reg.getActiveScope("io.example.app")).toBeNull();
	});

	it("setActiveScope round-trips through getActiveScope; default is null", () => {
		const reg = new ShortcutRegistry();
		expect(reg.getActiveScope("io.example.app")).toBeNull();
		reg.setActiveScope("io.example.app", "editor");
		expect(reg.getActiveScope("io.example.app")).toBe("editor");
		reg.setActiveScope("io.example.app", null);
		expect(reg.getActiveScope("io.example.app")).toBeNull();
	});

	it("listAll includes dynamic-only bindings (no static counterpart)", () => {
		const reg = new ShortcutRegistry();
		reg.registerAppDynamic("io.example.app", [
			{ id: "dyn-only", default: "Mod+G", label: "Dynamic only" },
		]);
		const ids = reg.listAll().map((b) => b.action.id);
		expect(ids).toContain("io.example.app/dyn-only");
	});

	it("conflicts() detects a dynamic-vs-shell collision", () => {
		const reg = new ShortcutRegistry();
		reg.registerShell();
		reg.registerAppDynamic("io.example.app", [
			{ id: "palette", default: "Mod+Shift+P", label: "Palette" },
		]);
		const conflicts = reg.conflicts();
		expect(conflicts.find((c) => c.chord === "cmdorctrl+shift+p")).toBeDefined();
	});
});

describe("shellBindings cache", () => {
	it("returns shell-layer bindings only and excludes app + dynamic", () => {
		const reg = new ShortcutRegistry();
		reg.registerShell();
		reg.registerApp("io.example.app", [{ id: "save", default: "Cmd+S", label: "Save" }]);
		reg.registerAppDynamic("io.example.app", [{ id: "dyn", default: "Cmd+K", label: "Dyn" }]);
		const ids = reg.shellBindings().map((b) => b.action.id);
		expect(ids.every((id) => id.startsWith("shell/"))).toBe(true);
		expect(ids).toContain("shell/launcher");
		expect(ids).not.toContain("io.example.app/save");
		expect(ids).not.toContain("io.example.app/dyn");
	});

	it("reuses the same cached array until a shell mutation invalidates it", () => {
		const reg = new ShortcutRegistry();
		reg.registerShell();
		const a = reg.shellBindings();
		const b = reg.shellBindings();
		expect(a).toBe(b);
		reg.overrideOne("shell/marketplace", "Mod+Shift+M");
		const c = reg.shellBindings();
		expect(c).not.toBe(a);
		expect(c.find((x) => x.action.id === "shell/marketplace")?.chord).toBe("Mod+Shift+M");
	});

	it("registering app shortcuts does NOT bust the shell cache (no shared state)", () => {
		const reg = new ShortcutRegistry();
		reg.registerShell();
		const a = reg.shellBindings();
		reg.registerApp("io.example.app", [{ id: "save", default: "Cmd+S", label: "Save" }]);
		const b = reg.shellBindings();
		expect(a).toBe(b);
	});
});

describe("shellChordSet (6.10b)", () => {
	it("returns normalized shell-layer chords only", () => {
		const reg = new ShortcutRegistry();
		reg.registerShell();
		reg.registerApp("io.example.app", [{ id: "save", default: "Cmd+S", label: "Save" }]);
		const set = shellChordSet(reg);
		// Some shell defaults must be present, normalized.
		expect(set.has("cmdorctrl+space")).toBe(true);
		// App chord must NOT be in the shell set.
		expect(set.has("cmd+s")).toBe(false);
	});

	it("a user-rebound shell chord frees the original chord", () => {
		const reg = new ShortcutRegistry();
		reg.registerShell();
		const before = shellChordSet(reg);
		expect(before.has("cmdorctrl+shift+p")).toBe(true);
		reg.overrideOne("shell/marketplace", "Mod+Shift+M");
		const after = shellChordSet(reg);
		expect(after.has("cmdorctrl+shift+p")).toBe(false);
		expect(after.has("cmdorctrl+shift+m")).toBe(true);
	});

	it("a cleared shell binding leaves no chord", () => {
		const reg = new ShortcutRegistry();
		reg.registerShell();
		reg.overrideOne("shell/marketplace", null);
		const set = shellChordSet(reg);
		expect(set.has("cmdorctrl+shift+p")).toBe(false);
	});
});
