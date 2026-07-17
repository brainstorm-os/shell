/**
 * pin-resolver — live presentation for entity pins. Pure; no DB. Pins
 * persist only the entity id, so every test asserts the resolver derives
 * label / icon / opener-badge / tombstone purely from injected lookups.
 */

import { IconKind } from "@brainstorm/sdk-types";
import { describe, expect, it } from "vitest";
import type { IconRecord } from "./dashboard-store";
import { type PinResolverDeps, resolvePins } from "./pin-resolver";

const NOTE_TYPE = "io.brainstorm.notes/Note/v1";

function entityIcon(id: string, x: number, y: number): IconRecord {
	return { x, y, kind: "entity", target: id, label: "stale label" };
}

const APP_NAMES: Record<string, string> = { "io.brainstorm.notes": "Notes" };

const deps = (
	entities: Record<string, { type: string; properties: Record<string, unknown> }>,
	openers: Record<string, string | null> = { [NOTE_TYPE]: "io.brainstorm.notes" },
): PinResolverDeps => ({
	getEntity: (id) => entities[id] ?? null,
	resolveOpenerApp: (type) => openers[type] ?? null,
	resolveAppName: (appId) => APP_NAMES[appId] ?? appId,
});

describe("resolvePins", () => {
	it("resolves entity AND app icons; view icons are skipped", () => {
		const icons: Record<string, IconRecord> = {
			a: { x: 0, y: 0, kind: "app", target: "io.brainstorm.notes", label: "Notes" },
			v: { x: 1, y: 0, kind: "view", target: "view-1", label: "All People" },
			e: entityIcon("ent-1", 2, 0),
		};
		const out = resolvePins(
			icons,
			deps({ "ent-1": { type: NOTE_TYPE, properties: { title: "Hello" } } }),
		);
		expect(Object.keys(out).sort()).toEqual(["a", "e"]);
	});

	it("app pins live-resolve their label from the registry — a rename reaches old pins", () => {
		// The stored label is the install-time snapshot ("Form Designer");
		// the registry now says "Forms" (903 dogfood: stale pre-rename labels).
		const icons: Record<string, IconRecord> = {
			a: { x: 0, y: 0, kind: "app", target: "io.brainstorm.form-designer", label: "Form Designer" },
		};
		const out = resolvePins(icons, {
			getEntity: () => null,
			resolveOpenerApp: () => null,
			resolveAppName: (id) => (id === "io.brainstorm.form-designer" ? "Forms" : id),
		});
		expect(out.a?.label).toBe("Forms");
		expect(out.a?.missing).toBe(false);
	});

	it("an app the registry no longer knows keeps its stored label", () => {
		const icons: Record<string, IconRecord> = {
			a: { x: 0, y: 0, kind: "app", target: "io.gone.app", label: "Old Friend" },
		};
		const out = resolvePins(icons, {
			getEntity: () => null,
			resolveOpenerApp: () => null,
			// Contract: resolveAppName falls back to the id for unknown apps.
			resolveAppName: (id) => id,
		});
		expect(out.a?.label).toBe("Old Friend");
	});

	it("derives label from title, icon from properties.icon, badge from opener", () => {
		const out = resolvePins(
			{ e: entityIcon("ent-1", 0, 0) },
			deps({
				"ent-1": {
					type: NOTE_TYPE,
					properties: { title: "Quarterly plan", icon: { kind: IconKind.Emoji, value: "📓" } },
				},
			}),
		);
		expect(out.e).toEqual({
			label: "Quarterly plan",
			icon: { kind: IconKind.Emoji, value: "📓" },
			appId: "io.brainstorm.notes",
			appName: "Notes",
			missing: false,
		});
	});

	it("falls back title→name and never returns an empty label", () => {
		const out = resolvePins(
			{ e: entityIcon("ent-1", 0, 0) },
			deps({ "ent-1": { type: NOTE_TYPE, properties: { name: "Ada Lovelace" } } }),
		);
		expect(out.e?.label).toBe("Ada Lovelace");

		const noTitle = resolvePins(
			{ e: { x: 0, y: 0, kind: "entity", target: "ent-1", label: "" } },
			deps({ "ent-1": { type: NOTE_TYPE, properties: {} } }),
		);
		// no title/name, no stored label → entity id, never "".
		expect(noTitle.e?.label).toBe("ent-1");
	});

	it("a malformed icon blob degrades to null (badge fallback), never throws", () => {
		const out = resolvePins(
			{ e: entityIcon("ent-1", 0, 0) },
			deps({ "ent-1": { type: NOTE_TYPE, properties: { title: "X", icon: { junk: true } } } }),
		);
		expect(out.e?.icon).toBeNull();
		expect(out.e?.missing).toBe(false);
	});

	it("a vanished target is a tombstone keyed off the stored label, not removed", () => {
		const out = resolvePins({ e: entityIcon("gone", 3, 1) }, deps({}));
		expect(out.e).toEqual({
			label: "stale label",
			icon: null,
			appId: null,
			appName: null,
			missing: true,
		});
	});

	it("badge identity falls back to the app id when the opener has no friendly name", () => {
		const out = resolvePins(
			{ e: entityIcon("ent-1", 0, 0) },
			deps(
				{ "ent-1": { type: "io.acme/Deal/v1", properties: { title: "D" } } },
				{ "io.acme/Deal/v1": "io.acme.crm" },
			),
		);
		expect(out.e?.appId).toBe("io.acme.crm");
		expect(out.e?.appName).toBe("io.acme.crm");
	});

	it("no registered opener → null badge (tile uses the object icon alone)", () => {
		const out = resolvePins(
			{ e: entityIcon("ent-1", 0, 0) },
			deps({ "ent-1": { type: "io.acme/Widget/v1", properties: { title: "W" } } }, {}),
		);
		expect(out.e?.appId).toBeNull();
		expect(out.e?.missing).toBe(false);
	});
});
