/**
 * Agent-5 — the pure per-conversation settings helpers: grant narrowing +
 * escalation merge (security keystones), provider derivation, and budget
 * accounting. The three-tier intersection stays the chokepoint
 * (`agent-tools.test.ts`); these cover the new narrowing/merge/budget math.
 */

import { OLLAMA_PROVIDER_ID } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	AUTO_PROVIDER,
	BudgetVerdict,
	accrueSpend,
	budgetCheck,
	composeGrants,
	defaultGrants,
	enabledToggleableGrants,
	grantCapability,
	grantedProviderIds,
	grantsCover,
	isToggleableGrant,
	nonToggleableAppCaps,
	providerForRequest,
	resolveProvider,
	toggleableAppCaps,
} from "../src/logic/conversation-settings";

const APP_CAPS = [
	"storage.kv",
	"ai.use",
	"ai.provider:ollama",
	"ai.provider:anthropic",
	"search.read",
	"search.hybrid",
	"entities.read:*",
	"entities.write:brainstorm/Conversation/v1",
	"intents.dispatch:open",
	"intents.dispatch:create",
];

describe("toggleable grants partition", () => {
	it("only intents.dispatch:* caps are toggleable", () => {
		expect(isToggleableGrant("intents.dispatch:open")).toBe(true);
		expect(isToggleableGrant("ai.use")).toBe(false);
		expect(isToggleableGrant("entities.read:*")).toBe(false);
	});

	it("toggleable surface is the dispatch caps, sorted + deduped", () => {
		expect(toggleableAppCaps(APP_CAPS)).toEqual(["intents.dispatch:create", "intents.dispatch:open"]);
	});

	it("non-toggleable caps are the infrastructure substrate", () => {
		const infra = nonToggleableAppCaps(APP_CAPS);
		expect(infra).toContain("ai.use");
		expect(infra).toContain("entities.read:*");
		expect(infra).not.toContain("intents.dispatch:open");
	});
});

describe("composeGrants (narrow only)", () => {
	it("always keeps the non-toggleable substrate even with nothing enabled", () => {
		const grants = composeGrants(APP_CAPS, []);
		expect(grants).toContain("ai.use");
		expect(grants).toContain("entities.read:*");
		expect(grants).not.toContain("intents.dispatch:open");
		expect(grants).not.toContain("intents.dispatch:create");
	});

	it("adds the user-enabled toggleable caps on top of the substrate", () => {
		const grants = composeGrants(APP_CAPS, ["intents.dispatch:open"]);
		expect(grants).toContain("intents.dispatch:open");
		expect(grants).not.toContain("intents.dispatch:create");
		expect(grants).toContain("ai.use");
	});

	it("fail-closed: drops an enabled cap the app does NOT hold", () => {
		const grants = composeGrants(APP_CAPS, ["intents.dispatch:delete"]);
		expect(grants).not.toContain("intents.dispatch:delete");
	});

	it("fail-closed: ignores a non-toggleable cap smuggled into the enabled set", () => {
		const grants = composeGrants(APP_CAPS, ["entities.write:brainstorm/Secret/v1"]);
		expect(grants).not.toContain("entities.write:brainstorm/Secret/v1");
	});
});

describe("enabledToggleableGrants (the UI's checked rows)", () => {
	it("defaultGrants enables every toggleable cap", () => {
		expect(enabledToggleableGrants(APP_CAPS, defaultGrants(APP_CAPS))).toEqual([
			"intents.dispatch:create",
			"intents.dispatch:open",
		]);
	});

	it("reflects a narrowed stored grant set", () => {
		const stored = composeGrants(APP_CAPS, ["intents.dispatch:open"]);
		expect(enabledToggleableGrants(APP_CAPS, stored)).toEqual(["intents.dispatch:open"]);
	});
});

describe("grantCapability (escalation merge — explicit consent)", () => {
	it("adds an app-held cap to a narrowed grant set", () => {
		const narrowed = composeGrants(APP_CAPS, []);
		expect(grantsCover(narrowed, "intents.dispatch:open")).toBe(false);
		const escalated = grantCapability(APP_CAPS, narrowed, "intents.dispatch:open");
		expect(escalated).toContain("intents.dispatch:open");
		expect(grantsCover(escalated, "intents.dispatch:open")).toBe(true);
	});

	it("fail-closed: refuses to grant a cap the app does NOT hold (no-op)", () => {
		const narrowed = composeGrants(APP_CAPS, []);
		const escalated = grantCapability(APP_CAPS, narrowed, "intents.dispatch:delete");
		expect(escalated).not.toContain("intents.dispatch:delete");
		expect(escalated).toEqual([...narrowed].sort());
	});

	it("is idempotent — re-granting an already-held cap changes nothing", () => {
		const grants = composeGrants(APP_CAPS, ["intents.dispatch:open"]);
		const again = grantCapability(APP_CAPS, grants, "intents.dispatch:open");
		expect(again).toEqual([...grants].sort());
	});

	it("a `*`-scoped app cap covers a scoped escalation", () => {
		const escalated = grantCapability(
			["entities.read:*"],
			["ai.use"],
			"entities.read:brainstorm/Note/v1",
		);
		expect(escalated).toContain("entities.read:brainstorm/Note/v1");
	});
});

describe("provider derivation", () => {
	it("offers only the providers the app holds caps for, local model first", () => {
		expect(grantedProviderIds(APP_CAPS)).toEqual([OLLAMA_PROVIDER_ID, "anthropic"]);
	});

	it("ignores a wildcard provider cap (never offers `*`)", () => {
		expect(grantedProviderIds(["ai.provider:*", "ai.use"])).toEqual([]);
	});

	it("resolveProvider keeps a still-granted stored provider", () => {
		expect(resolveProvider(APP_CAPS, "anthropic")).toBe("anthropic");
	});

	it("resolveProvider falls back to AUTO for an ungranted / absent stored provider", () => {
		expect(resolveProvider(APP_CAPS, "openai")).toBe(AUTO_PROVIDER);
		expect(resolveProvider(APP_CAPS, undefined)).toBe(AUTO_PROVIDER);
	});

	it("providerForRequest maps AUTO to undefined (shell routes) and a real id through", () => {
		expect(providerForRequest(AUTO_PROVIDER)).toBeUndefined();
		expect(providerForRequest("anthropic")).toBe("anthropic");
	});
});

describe("budgetCheck (fail-closed budget accounting)", () => {
	it("no budget → always Ok (unbounded)", () => {
		expect(budgetCheck(undefined, 0, 1000).verdict).toBe(BudgetVerdict.Ok);
		expect(budgetCheck(0, 999999, 999999).verdict).toBe(BudgetVerdict.Ok);
	});

	it("a turn that fits under the budget is Ok", () => {
		const state = budgetCheck(1000, 200, 300);
		expect(state.verdict).toBe(BudgetVerdict.Ok);
		expect(state.projectedTotal).toBe(500);
		expect(state.remainingBefore).toBe(800);
	});

	it("a turn landing EXACTLY on the ceiling is allowed", () => {
		expect(budgetCheck(1000, 700, 300).verdict).toBe(BudgetVerdict.Ok);
	});

	it("a turn that would exceed the budget is refused (strictly greater)", () => {
		const state = budgetCheck(1000, 800, 300);
		expect(state.verdict).toBe(BudgetVerdict.Exceeds);
		expect(state.projectedTotal).toBe(1100);
	});

	it("clamps a corrupt negative/NaN spent or turn to zero", () => {
		expect(budgetCheck(1000, Number.NaN, -50).verdict).toBe(BudgetVerdict.Ok);
		expect(budgetCheck(1000, -100, 1100).verdict).toBe(BudgetVerdict.Exceeds);
	});
});

describe("accrueSpend", () => {
	it("adds the turn to the running total", () => {
		expect(accrueSpend(500, 200)).toBe(700);
	});

	it("clamps corrupt inputs to zero before adding", () => {
		expect(accrueSpend(Number.NaN, 200)).toBe(200);
		expect(accrueSpend(-10, -5)).toBe(0);
	});
});
