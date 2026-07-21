/**
 * `contactObjectMenuContext` — the Contacts header ⋯ / title menu must
 * resolve into a populated shared object menu: Open routes through the
 * intents service, Pin/Unpin appears when the shell exposes the dashboard
 * surface and the app holds `dashboard.pin`, the vCard import/export extras
 * ride the overflow, and Remove is the destructive tail. The regression this
 * guards: `asObjectMenuRuntime` previously collapsed `services` to `null`
 * when intents was absent AND never forwarded the dashboard surface, so the
 * Pin toggle could never render (F — Contacts ⋯ menu missing items).
 */

import {
	type ObjectMenuExtraItem,
	type ObjectMenuRuntime,
	buildObjectMenuItems,
} from "@brainstorm-os/sdk/object-menu";
import { describe, expect, it } from "vitest";
import type { ContactsRuntime } from "../runtime";
import { PERSON_TYPE, type Person } from "../types/person";
import { contactObjectMenuContext } from "./contact-menu";

const PIN_CAP = "dashboard.pin";

function person(): Person {
	return {
		id: "person-1",
		name: "Ada Lovelace",
		emails: [],
		phones: [],
		companyId: null,
		role: "",
		birthday: null,
		anniversary: null,
		linkIds: [],
		bio: "",
	};
}

function itemIds(runtime: ObjectMenuRuntime, extras: ObjectMenuExtraItem[]): string[] {
	return buildObjectMenuItems({
		target: { entityId: "person-1", entityType: PERSON_TYPE, label: "Ada Lovelace" },
		runtime,
		pinned: false,
		extraItems: extras,
		onRemove: () => {},
	}).map((i) => i.id);
}

describe("contactObjectMenuContext", () => {
	it("never collapses services to null — it is always an object", () => {
		// A runtime with no services at all (preview / standalone) must still
		// resolve to a non-null services object so the builder's optional
		// chaining reads work and the menu populates.
		const ctx = contactObjectMenuContext({
			person: person(),
			runtime: { capabilities: [] } as ContactsRuntime,
			onRemove: () => {},
		});
		expect(ctx).not.toBeNull();
		expect(ctx?.runtime?.services).not.toBeNull();
		expect(typeof ctx?.runtime?.services).toBe("object");
	});

	it("forwards the dashboard surface so Pin renders when granted", () => {
		const runtime = {
			capabilities: [PIN_CAP],
			services: {
				intents: { dispatch: async () => undefined },
				dashboard: {
					pin: async () => true,
					unpin: async () => true,
					isPinned: async () => false,
				},
			},
		} as unknown as ContactsRuntime;

		const ctx = contactObjectMenuContext({ person: person(), runtime, onRemove: () => {} });
		const ids = itemIds(ctx?.runtime ?? null, []);
		expect(ids).toContain("open");
		expect(ids).toContain("pin");
		expect(ids).toContain("remove");
	});

	it("omits Pin when the dashboard surface is absent (older shell)", () => {
		const runtime = { capabilities: [PIN_CAP], services: {} } as unknown as ContactsRuntime;
		const ctx = contactObjectMenuContext({ person: person(), runtime, onRemove: () => {} });
		const ids = itemIds(ctx?.runtime ?? null, []);
		expect(ids).toContain("open");
		expect(ids).not.toContain("pin");
		expect(ids).toContain("remove");
	});

	it("splices the vCard import/export extras into the menu", () => {
		const extras: ObjectMenuExtraItem[] = [
			{ id: "vcard-import", label: "Import vCard…", run: () => {} },
			{ id: "vcard-export", label: "Export vCard…", run: () => {} },
		];
		const ctx = contactObjectMenuContext({
			person: person(),
			runtime: { capabilities: [], services: {} } as unknown as ContactsRuntime,
			onRemove: () => {},
			extraItems: extras,
		});
		const ids = itemIds(ctx?.runtime ?? null, ctx?.extraItems ?? []);
		expect(ids).toEqual(["open", "vcard-import", "vcard-export", "remove"]);
	});
});
