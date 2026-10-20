import { afterEach, describe, expect, it, vi } from "vitest";
import { TrayHost, TrayShellAction, getTrayHost, resetTrayHost } from "./tray-host";

afterEach(() => resetTrayHost());

describe("TrayHost.publish — validation", () => {
	const host = () => new TrayHost();

	it("rejects a non-object / missing items / empty items as Invalid", () => {
		for (const bad of [null, [], "x", {}, { items: "no" }, { items: [] }]) {
			expect(() => host().publish("a", bad)).toThrowError(
				expect.objectContaining({ name: "Invalid" }),
			);
		}
	});

	it("rejects more than 24 items", () => {
		const items = Array.from({ length: 25 }, (_, i) => ({ id: `i${i}`, label: `L${i}` }));
		expect(() => host().publish("a", { items })).toThrowError(
			expect.objectContaining({ name: "Invalid" }),
		);
	});

	it("rejects an item with no id / no label, and a bad intent", () => {
		expect(() => host().publish("a", { items: [{ label: "x" }] })).toThrowError(/id/);
		expect(() => host().publish("a", { items: [{ id: "x" }] })).toThrowError(/label/);
		expect(() =>
			host().publish("a", { items: [{ id: "x", label: "x", intent: { verb: "" } }] }),
		).toThrowError(expect.objectContaining({ name: "Invalid" }));
	});

	it("defaults enabled to true, coerces non-true to false, defaults intent payload to {}", () => {
		const h = host();
		h.publish("a", {
			items: [
				{ id: "1", label: "A" },
				{ id: "2", label: "B", enabled: false },
				{ id: "3", label: "C", enabled: "yes", intent: { verb: "open" } },
			],
		});
		const items = h.compose()?.entries.filter((e) => e.kind === "item") ?? [];
		expect(items).toEqual([
			expect.objectContaining({ itemId: "1", enabled: true }),
			expect.objectContaining({ itemId: "2", enabled: false }),
			expect.objectContaining({ itemId: "3", enabled: false, intent: { verb: "open", payload: {} } }),
		]);
	});

	it("clamps an over-long label with an ellipsis", () => {
		const h = host();
		h.publish("a", { items: [{ id: "1", label: "x".repeat(200) }] });
		const item = h.compose()?.entries.find((e) => e.kind === "item");
		expect(item && "label" in item && item.label.length).toBe(80);
	});
});

describe("TrayHost.compose — menu model", () => {
	it("is null with no publishers (tray torn down, not an empty icon)", () => {
		expect(new TrayHost().compose()).toBeNull();
	});

	it("orders sections by publish order with a separator + header per app", () => {
		const h = new TrayHost();
		h.publish("app.one", { items: [{ id: "a", label: "One-A" }] });
		h.publish("app.two", { items: [{ id: "b", label: "Two-B" }] });
		const kinds = h
			.compose()
			?.entries.map((e) =>
				e.kind === "header" ? `H:${e.appId}` : e.kind === "item" ? `I:${e.itemId}` : "—",
			);
		expect(kinds).toEqual(["H:app.one", "I:a", "—", "H:app.two", "I:b"]);
	});

	it("re-publish replaces the section and moves it to the end", () => {
		const h = new TrayHost();
		h.publish("app.one", { items: [{ id: "a", label: "A" }] });
		h.publish("app.two", { items: [{ id: "b", label: "B" }] });
		h.publish("app.one", { items: [{ id: "a2", label: "A2" }] });
		const headers = h
			.compose()
			?.entries.filter((e) => e.kind === "header")
			.map((e) => (e.kind === "header" ? e.appId : ""));
		expect(headers).toEqual(["app.two", "app.one"]);
	});

	it("a single publisher's tooltip names the tray; multiple → product name", () => {
		const h = new TrayHost();
		h.publish("a", { tooltip: "Notes", items: [{ id: "x", label: "X" }] });
		expect(h.compose()?.tooltip).toBe("Notes");
		h.publish("b", { tooltip: "Tasks", items: [{ id: "y", label: "Y" }] });
		expect(h.compose()?.tooltip).toBe("Brainstorm");
	});
});

describe("TrayHost — change notifications + lifecycle", () => {
	it("emits the composed model on publish and null when the last app clears", () => {
		const h = new TrayHost();
		const seen: Array<unknown> = [];
		h.setListener((t) => seen.push(t));
		h.publish("a", { items: [{ id: "x", label: "X" }] });
		h.clear("a");
		expect(seen[0]).not.toBeNull();
		expect(seen[1]).toBeNull();
	});

	it("clear() of an unknown app does not emit", () => {
		const h = new TrayHost();
		const listener = vi.fn();
		h.setListener(listener);
		h.clear("nobody");
		expect(listener).not.toHaveBeenCalled();
	});

	it("reset() drops every publisher and emits null once", () => {
		const h = new TrayHost();
		h.publish("a", { items: [{ id: "x", label: "X" }] });
		const listener = vi.fn();
		h.setListener(listener);
		h.reset();
		expect(listener).toHaveBeenCalledExactlyOnceWith(null);
		h.reset(); // idempotent — nothing to drop
		expect(listener).toHaveBeenCalledTimes(1);
	});
});

describe("getTrayHost", () => {
	it("is a stable singleton until reset", () => {
		const a = getTrayHost();
		expect(getTrayHost()).toBe(a);
		resetTrayHost();
		expect(getTrayHost()).not.toBe(a);
	});
});

describe("TrayHost shell items (7.16 close to tray)", () => {
	const SHELL = [
		{ action: TrayShellAction.Open, label: "Open Brainstorm" },
		{ action: TrayShellAction.Quit, label: "Quit Brainstorm" },
	];

	it("keeps a tray alive with no app publishing, shell items only", () => {
		const host = new TrayHost();
		host.setShellItems(SHELL);
		expect(host.compose()).toEqual({
			tooltip: "Brainstorm",
			entries: [
				{ kind: "shell", action: TrayShellAction.Open, label: "Open Brainstorm" },
				{ kind: "shell", action: TrayShellAction.Quit, label: "Quit Brainstorm" },
			],
		});
	});

	it("leads app sections, separated, and removing them tears the tray down again", () => {
		const host = new TrayHost();
		const changes: unknown[] = [];
		host.setListener((tray) => changes.push(tray));
		host.setShellItems(SHELL);
		host.publish("io.x", { items: [{ id: "a", label: "A" }] });
		const kinds = host.compose()?.entries.map((e) => e.kind);
		expect(kinds).toEqual(["shell", "shell", "separator", "header", "item"]);
		host.clear("io.x");
		host.setShellItems([]);
		expect(host.compose()).toBeNull();
		expect(changes.at(-1)).toBeNull();
	});

	it("clearing shell items that were never set does not emit", () => {
		const host = new TrayHost();
		const listener = vi.fn();
		host.setListener(listener);
		host.setShellItems([]);
		expect(listener).not.toHaveBeenCalled();
	});
});
