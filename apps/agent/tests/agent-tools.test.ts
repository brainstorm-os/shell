/**
 * Agent-3 — the three-tier capability ceiling + curated tools. The security
 * keystone: agent-tools ⊆ conversation-grants ⊆ app-caps, fail-closed at every
 * tier. The loop's two-tier intersection is tested in sdk-types; these tests
 * cover the THIRD tier this app adds (the conversation grant) and the curated
 * catalogue.
 */

import { intersectAgentTools } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	AGENT_TOOL_VERB,
	curatedAgentTools,
	curatedToolCapabilities,
	defaultConversationGrants,
	effectiveAgentCapabilities,
	toolCallToIntent,
} from "../src/logic/agent-tools";
import { PROPOSE_ROW_VERB } from "../src/logic/propose-row";

const APP_CAPS = [
	"storage.kv",
	"ai.use",
	"ai.provider:ollama",
	"entities.read:*",
	"entities.write:brainstorm/Conversation/v1",
	"entities.write:brainstorm/Message/v1",
	"intents.dispatch:open",
];

const id = (s: string): string => s;

describe("curated agent tools", () => {
	it("leads with the read-only `open` tool (verb-collision-safe)", () => {
		const tools = curatedAgentTools(id);
		expect(tools[0]?.verb).toBe(AGENT_TOOL_VERB.Open);
		// No declared entityType — the shell resolves the id's type server-side.
		expect(tools[0]?.entityType).toBeUndefined();
	});

	it("exposes the Agent-11 propose-* tools alongside `open`", () => {
		const verbs = curatedAgentTools(id).map((t) => t.verb);
		expect(verbs).toEqual([
			"open",
			"propose-note",
			"propose-task",
			"propose-event",
			"propose-bookmark",
			"propose-contact",
		]);
		// A propose tool never declares an entityType (so it can't require
		// read/write) — it only ever stages a draft for the user's approval.
		for (const tool of curatedAgentTools(id)) {
			if (tool.verb !== AGENT_TOOL_VERB.Open) expect(tool.entityType).toBeUndefined();
		}
	});

	it("the curated footprint is exactly the open + propose dispatch verbs", () => {
		expect(curatedToolCapabilities()).toEqual([
			"intents.dispatch:open",
			"intents.dispatch:propose-bookmark",
			"intents.dispatch:propose-contact",
			"intents.dispatch:propose-event",
			"intents.dispatch:propose-note",
			"intents.dispatch:propose-row",
			"intents.dispatch:propose-task",
		]);
	});

	it("offers the row tool only when the vault actually has databases (Agent-11d)", () => {
		const verbs = (options?: { hasDatabases: boolean }) =>
			curatedAgentTools(id, options).map((tool) => tool.verb);
		expect(verbs()).not.toContain(PROPOSE_ROW_VERB);
		expect(verbs({ hasDatabases: false })).not.toContain(PROPOSE_ROW_VERB);
		expect(verbs({ hasDatabases: true })).toContain(PROPOSE_ROW_VERB);
	});
});

describe("effectiveAgentCapabilities (the third tier)", () => {
	it("defaults to the full app caps when the conversation grants everything", () => {
		const grants = defaultConversationGrants(APP_CAPS);
		expect(effectiveAgentCapabilities(APP_CAPS, grants)).toEqual(APP_CAPS);
	});

	it("a conversation grant strictly NARROWS the app caps (intersection)", () => {
		// The conversation grants only `ai.use` — the frozen set is just that.
		const frozen = effectiveAgentCapabilities(APP_CAPS, ["ai.use"]);
		expect(frozen).toEqual(["ai.use"]);
	});

	it("fail-closed: a conversation grant the app does NOT hold is dropped", () => {
		const frozen = effectiveAgentCapabilities(APP_CAPS, [
			"ai.use",
			"intents.dispatch:delete", // not an app cap — must be dropped
		]);
		expect(frozen).toEqual(["ai.use"]);
		expect(frozen).not.toContain("intents.dispatch:delete");
	});

	it("a `*`-scoped app cap covers a scoped conversation grant", () => {
		const frozen = effectiveAgentCapabilities(
			["entities.read:*"],
			["entities.read:brainstorm/Note/v1"],
		);
		expect(frozen).toEqual(["entities.read:brainstorm/Note/v1"]);
	});
});

describe("three-tier narrowing end to end (agent-tools ⊆ conv-grants ⊆ app-caps)", () => {
	it("offers the open tool when the conversation grant keeps intents.dispatch:open", () => {
		const frozen = effectiveAgentCapabilities(APP_CAPS, defaultConversationGrants(APP_CAPS));
		const offered = intersectAgentTools(curatedAgentTools(id), frozen);
		expect(offered.map((t) => t.verb)).toEqual([AGENT_TOOL_VERB.Open]);
	});

	it("a tool requiring a cap the CONVERSATION tier dropped is not offered", () => {
		// The conversation narrows away intents.dispatch:open → the open tool's
		// footprint is no longer covered → it is dropped fail-closed.
		const frozen = effectiveAgentCapabilities(APP_CAPS, ["ai.use", "entities.read:*"]);
		expect(frozen).not.toContain("intents.dispatch:open");
		const offered = intersectAgentTools(curatedAgentTools(id), frozen);
		expect(offered).toEqual([]);
	});
});

describe("toolCallToIntent (security: declared verb/type, never model-supplied)", () => {
	it("dispatches the DECLARED verb and passes the model's args as payload", () => {
		const [tool] = curatedAgentTools(id);
		if (!tool) throw new Error("expected a curated tool");
		const intent = toolCallToIntent(tool, {
			tool: AGENT_TOOL_VERB.Open,
			args: { entityId: "ent_123" },
		});
		expect(intent.verb).toBe(AGENT_TOOL_VERB.Open);
		expect(intent.payload).toEqual({ entityId: "ent_123" });
	});

	it("strips a model-supplied entityType when the tool declares none", () => {
		const [tool] = curatedAgentTools(id);
		if (!tool) throw new Error("expected a curated tool");
		const intent = toolCallToIntent(tool, {
			tool: AGENT_TOOL_VERB.Open,
			// the model tries to smuggle a type — the shell resolves it, so we drop it
			args: { entityId: "ent_123", entityType: "brainstorm/Secret/v1" },
		});
		expect(intent.payload.entityType).toBeUndefined();
	});

	it("a declared entityType OVERRIDES a model-supplied one", () => {
		const intent = toolCallToIntent(
			{ verb: "open", entityType: "brainstorm/Note/v1", label: "x" },
			{ tool: "open", args: { entityId: "ent_1", entityType: "brainstorm/Other/v1" } },
		);
		expect(intent.payload.entityType).toBe("brainstorm/Note/v1");
	});
});
