/**
 * The Settings sidebar is a *grouped* nav (owner report 2026-08-10: "the menu
 * in settings is too complex and should be split in sections, now it's a
 * mess"). This file fences the three ways that grouping can silently rot:
 *
 *  1. A new `SettingsSection` lands with a group nobody renders — the item
 *     would vanish from the sidebar with no build or runtime signal. `SECTIONS`
 *     stays the single declaration site; `NAV_GROUPS` is *derived* from it, so
 *     a dropped item shows up here as a count mismatch.
 *  2. The derived flat order drifts from the rendered order. The composite
 *     keyboard (roving tabindex + type-ahead) indexes `NAV_ITEMS` positionally,
 *     so "flatten(NAV_GROUPS) === NAV_ITEMS" is a keyboard-correctness
 *     invariant, not a cosmetic one.
 *  3. Two sections share an icon. Covers / Apps & contributions / AI all shipped
 *     `IconName.Sparkle`, which made the glyph column carry zero information.
 */

import { describe, expect, it } from "vitest";
import { t } from "../i18n/t";
import type { IconName } from "../ui/icon";
import { SETTINGS_GROUP_LABEL_KEYS, SETTINGS_GROUP_ORDER, SettingsGroup } from "./sections";
import { NAV_GROUPS, NAV_ITEMS, SECTIONS } from "./settings";

describe("Settings nav groups", () => {
	it("the group order covers every SettingsGroup exactly once", () => {
		expect([...SETTINGS_GROUP_ORDER].sort()).toEqual(
			(Object.values(SettingsGroup) as SettingsGroup[]).sort(),
		);
		expect(new Set(SETTINGS_GROUP_ORDER).size).toBe(SETTINGS_GROUP_ORDER.length);
	});

	it("every group has a label key that resolves to a real i18n string", () => {
		for (const group of SETTINGS_GROUP_ORDER) {
			const key = SETTINGS_GROUP_LABEL_KEYS[group];
			expect(key, `no label key for group=${group}`).toBeTruthy();
			expect(t(key), `labelKey=${key} for group=${group}`).not.toMatch(/^\[\?/);
		}
	});

	it("no section is dropped by the grouping — every SECTIONS entry lands in exactly one group", () => {
		const grouped = NAV_GROUPS.flatMap((group) => group.items.map((entry) => entry.id));
		expect(grouped.length, "a section declared a group that no rendered group owns").toBe(
			SECTIONS.length,
		);
		expect(new Set(grouped).size).toBe(SECTIONS.length);
		expect([...grouped].sort()).toEqual(SECTIONS.map((entry) => entry.id).sort());
	});

	it("no group is empty — an empty heading is a rendered lie", () => {
		for (const group of NAV_GROUPS) {
			expect(group.items.length, `group=${group.id} has no sections`).toBeGreaterThan(0);
		}
	});

	it("NAV_ITEMS is exactly the flattened group order (the keyboard index space)", () => {
		expect(NAV_ITEMS.map((entry) => entry.id)).toEqual(
			NAV_GROUPS.flatMap((group) => group.items.map((entry) => entry.id)),
		);
	});

	it("each group's startIndex is its offset into NAV_ITEMS", () => {
		let offset = 0;
		for (const group of NAV_GROUPS) {
			expect(group.startIndex, `group=${group.id}`).toBe(offset);
			for (const [i, entry] of group.items.entries()) {
				expect(NAV_ITEMS[offset + i]?.id, `group=${group.id} item ${i}`).toBe(entry.id);
			}
			offset += group.items.length;
		}
		expect(offset).toBe(NAV_ITEMS.length);
	});

	it("no two sections share an icon — the glyph column has to distinguish", () => {
		const seen = new Map<IconName, string>();
		const collisions: string[] = [];
		for (const entry of SECTIONS) {
			const previous = seen.get(entry.icon);
			if (previous !== undefined) collisions.push(`${entry.icon}: ${previous} + ${entry.id}`);
			else seen.set(entry.icon, entry.id);
		}
		expect(collisions, "sections sharing one icon").toEqual([]);
	});
});
