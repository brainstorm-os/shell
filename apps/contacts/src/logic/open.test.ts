import type { IntentsService } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { COMPANY_TYPE, PERSON_TYPE, type VaultEntityLike } from "../types/person";
import { openEntityRef, resolveOpenTarget } from "./open";

function entity(id: string, type: string): VaultEntityLike {
	return { id, type, properties: {} };
}

/**
 * F-242 — clicking a contact's Company chip must dispatch a canonical
 * `open` intent carrying the Company entity id, not navigate the window
 * (the stale-build symptom was a bare anchor href resolving to
 * `…/renderer/index.html`). These lock the dispatch contract so the chip
 * always routes through the intents service.
 */
function fakeIntents(): IntentsService & { dispatch: ReturnType<typeof vi.fn> } {
	return {
		dispatch: vi.fn(async () => null),
		suggest: vi.fn(async () => []),
		suggestActions: vi.fn(async () => []),
	} as unknown as IntentsService & { dispatch: ReturnType<typeof vi.fn> };
}

describe("openEntityRef", () => {
	it("dispatches an open intent with the company id + type", () => {
		const intents = fakeIntents();
		openEntityRef(intents, "c_acme", COMPANY_TYPE);
		expect(intents.dispatch).toHaveBeenCalledTimes(1);
		expect(intents.dispatch).toHaveBeenCalledWith({
			verb: "open",
			payload: { entityId: "c_acme", entityType: COMPANY_TYPE },
		});
	});

	it("routes a related person the same way", () => {
		const intents = fakeIntents();
		openEntityRef(intents, "p_42", PERSON_TYPE);
		expect(intents.dispatch).toHaveBeenCalledWith({
			verb: "open",
			payload: { entityId: "p_42", entityType: PERSON_TYPE },
		});
	});

	it("is a safe no-op when the intents service is unavailable", () => {
		expect(() => openEntityRef(null, "c_acme", COMPANY_TYPE)).not.toThrow();
		expect(() => openEntityRef(undefined, "c_acme", COMPANY_TYPE)).not.toThrow();
	});
});

describe("resolveOpenTarget", () => {
	const snapshot = [entity("p_1", PERSON_TYPE), entity("c_acme", COMPANY_TYPE)];

	it("selects a Person directly", () => {
		expect(resolveOpenTarget("p_1", snapshot)).toEqual({ kind: "select", id: "p_1" });
	});

	it("lands a Company on its people view", () => {
		expect(resolveOpenTarget("c_acme", snapshot)).toEqual({ kind: "company", id: "c_acme" });
	});

	it("defaults a not-yet-loaded target to the company landing (Contacts owns Company opens)", () => {
		expect(resolveOpenTarget("c_unseen", snapshot)).toEqual({ kind: "company", id: "c_unseen" });
	});
});
