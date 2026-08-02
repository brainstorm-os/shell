/**
 * Tool-6 — projecting app tools into the agent loop's tool surface.
 *
 * Two things the shipped loop could not do, and one thing it must not start
 * doing, are pinned here: namespaced addressing (so two apps' tools stop
 * colliding), a real input schema, and OQ-TOOL-4's exclusion of sideloaded
 * providers from the model's prompt.
 */

import { describe, expect, it } from "vitest";
import { intersectAgentTools } from "./agent-loop";
import {
	AppToolEffect,
	type AppToolRecord,
	AppToolSurface,
	appToolCallCapability,
	appToolId,
	projectAppTools,
} from "./app-tools";
import { agentToolCapabilities } from "./automations";
import { ActionTrustTier } from "./contributed-actions";
import { ValueType } from "./properties";

function tool(appId: string, name: string, over: Partial<AppToolRecord> = {}): AppToolRecord {
	return {
		id: appToolId(appId, name),
		appId,
		name,
		title: over.title ?? name,
		description: over.description ?? "does a thing",
		effect: AppToolEffect.Pure,
		appliesTo: [],
		surfaces: [AppToolSurface.Agent],
		input: [],
		registeredAt: 1,
		trustTier: ActionTrustTier.Trusted,
		...over,
	};
}

describe("projectAppTools", () => {
	it("addresses a tool by its NAMESPACED id, so two apps stop colliding", () => {
		// The shipped loop addressed a tool by intent verb alone, which is why
		// the Agent ships exactly ONE curated `open` tool.
		const projected = projectAppTools([tool("io.a", "summarize"), tool("io.b", "summarize")]);
		expect(projected.map((t) => t.verb)).toEqual(["app.io.a.summarize", "app.io.b.summarize"]);
	});

	it("carries a real input schema, which intent-derived tools never had", () => {
		const projected = projectAppTools([
			tool("io.a", "rewrite", {
				input: [
					{ name: "text", description: "the text", required: true, valueType: ValueType.Text },
					{ name: "n", description: "how many", required: false, valueType: ValueType.Number },
				],
			}),
		]);
		expect(projected[0]?.inputSchema).toMatchObject({
			type: "object",
			required: ["text"],
			additionalProperties: false,
			properties: {
				text: { type: "string", description: "the text" },
				n: { type: "number" },
			},
		});
	});

	it("declares its own capability footprint, so ONE gate still covers it", () => {
		// `intersectAgentTools` is the loop's fail-closed keystone; an app tool
		// that needed a second mechanism would be a hole beside it.
		const [projected] = projectAppTools([tool("io.a", "rewrite")]);
		const cap = appToolCallCapability("io.a", "rewrite");
		expect(projected?.capabilities).toEqual([cap]);
		expect(intersectAgentTools([projected as never], [cap])).toHaveLength(1);
		expect(intersectAgentTools([projected as never], ["tools.call:io.other"])).toHaveLength(0);
	});

	it("derives an app tool's capability from its ID, not from what a step declared", () => {
		// Tool-9 routes on the shape of the verb, so if the capability came from
		// the declaration the two could disagree — a workflow step could put
		// `intents.dispatch:open` (already held) on the sheet the user approves
		// and then invoke an arbitrary app tool the frozen ceiling never covered.
		const lying = {
			verb: "app.io.rewriter.rewrite",
			label: "x",
			capabilities: ["intents.dispatch:open"],
		};
		expect(agentToolCapabilities(lying as never)).toEqual(["tools.call:io.rewriter/rewrite"]);
		// And an undeclared footprint does not fall back to an intent dispatch.
		expect(agentToolCapabilities({ verb: "app.io.rewriter.rewrite", label: "x" } as never)).toEqual([
			"tools.call:io.rewriter/rewrite",
		]);
		// A real intent verb is untouched.
		expect(agentToolCapabilities({ verb: "open", label: "x" } as never)).toEqual([
			"intents.dispatch:open",
		]);
	});

	it("EXCLUDES a sideloaded provider from the model's list (OQ-TOOL-4)", () => {
		// A menu can quarantine a sideloaded contribution under "More…"; a model
		// has no "More…" — a description is either in the prompt or it is not.
		expect(
			projectAppTools([tool("io.x", "rewrite", { trustTier: ActionTrustTier.Sideloaded })]),
		).toEqual([]);
		// An UNSTAMPED tier is not a promotion either — the field is optional, and
		// "we did not resolve one" must never read as trusted.
		const { trustTier: _dropped, ...unstamped } = tool("io.x", "rewrite");
		expect(projectAppTools([unstamped])).toEqual([]);
	});

	it("only projects tools that declared the agent surface", () => {
		expect(projectAppTools([tool("io.a", "menu-only", { surfaces: [AppToolSurface.Menu] })])).toEqual(
			[],
		);
		expect(projectAppTools([tool("io.a", "none", { surfaces: [] })])).toEqual([]);
	});

	it("never projects a tool whose stored declaration failed to re-validate", () => {
		expect(projectAppTools([tool("io.a", "bad", { declarationInvalid: true })])).toEqual([]);
	});

	it("coexists with intent-derived tools rather than replacing them (OQ-TOOL-2)", () => {
		// Verbs stay the ROUTING layer, tools the CALLING layer; both pass the
		// same intersection, so the union is one offered set.
		const intent = { verb: "open", label: "Open with X" };
		const union = [intent, ...projectAppTools([tool("io.a", "rewrite")])];
		const granted = ["intents.dispatch:open", appToolCallCapability("io.a", "rewrite")];
		expect(intersectAgentTools(union as never, granted)).toHaveLength(2);
	});
});
