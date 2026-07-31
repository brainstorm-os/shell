/**
 * Team surface (Agent-Teams-2) — the offerable grant catalog must be a strict
 * subset of the main-process agent-grantable vocabulary (the UI can never
 * offer what policy refuses, so a toggle never dead-ends), every catalog label
 * must exist in the en catalog, and the checklist state helpers round-trip the
 * ledger's split representation.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAgentGrantableCapability } from "@brainstorm-os/capabilities/agent-grants";
import { describe, expect, it } from "vitest";
import type { ShellAgent } from "../../preload";
import {
	TEAM_PROPOSE_GRANTS,
	TEAM_READ_GRANTS,
	TEAM_RUN_GRANTS,
	agentInitial,
	heldGrantSet,
	splitGrant,
} from "./team-section";

const ALL_OPTIONS = [...TEAM_READ_GRANTS, ...TEAM_PROPOSE_GRANTS, ...TEAM_RUN_GRANTS];

function agent(grants: Array<{ capability: string; scope: string | null }>): ShellAgent {
	return {
		id: "agt_1",
		pubkey: "cGs=",
		fingerprint: "ed25519:0123456789abcdef",
		displayName: "Researcher",
		avatarRef: null,
		persona: "",
		skills: [],
		routing: "local-only",
		autonomy: "confirm-on-write",
		memoryScope: "per-conversation",
		createdAt: 1,
		updatedAt: 1,
		grants: grants.map((g) => ({ ...g, grantedAt: 1 })),
	};
}

describe("team-section grant catalog", () => {
	it("offers ONLY capabilities the main-process policy will grant", () => {
		for (const option of ALL_OPTIONS) {
			expect(isAgentGrantableCapability(option.grant), option.grant).toBe(true);
		}
	});

	it("has no duplicate grants across groups", () => {
		const all = ALL_OPTIONS.map((o) => o.grant);
		expect(new Set(all).size).toBe(all.length);
	});

	it("labels every option from the en catalog", () => {
		const enPath = fileURLToPath(new URL("../i18n/en.json", import.meta.url));
		const catalog = JSON.parse(readFileSync(enPath, "utf8")) as Record<string, string>;
		for (const option of ALL_OPTIONS) {
			expect(catalog[option.labelKey], option.labelKey).toBeTruthy();
		}
	});
});

describe("team-section helpers", () => {
	it("splitGrant mirrors the ledger's capability/scope split", () => {
		expect(splitGrant("ai.use")).toEqual({ capability: "ai.use", scope: null });
		expect(splitGrant("entities.read:*")).toEqual({ capability: "entities.read", scope: "*" });
		expect(splitGrant("entities.read:brainstorm/Task/v1")).toEqual({
			capability: "entities.read",
			scope: "brainstorm/Task/v1",
		});
	});

	it("heldGrantSet reassembles full grant strings for checklist state", () => {
		const held = heldGrantSet(
			agent([
				{ capability: "ai.use", scope: null },
				{ capability: "entities.read", scope: "brainstorm/Task/v1" },
			]),
		);
		expect(held.has("ai.use")).toBe(true);
		expect(held.has("entities.read:brainstorm/Task/v1")).toBe(true);
		expect(held.has("entities.read")).toBe(false);
	});

	it("agentInitial falls back on empty names", () => {
		expect(agentInitial("researcher")).toBe("R");
		expect(agentInitial("  ")).toBe("?");
	});
});
