/**
 * Agent-grantable vocabulary (Agent-Teams-1) — the fail-closed policy behind
 * the Team surface's grant sheet. The security invariants pinned here are the
 * rung's core: an agent can never be granted a WRITE, a NETWORK reach, or a
 * non-propose dispatch — the propose→approve pipeline (Agent-11b) is the only
 * road to persisted bytes, and it runs under the approving HUMAN's app caps.
 */

import { describe, expect, it } from "vitest";
import { isAgentGrantableCapability } from "./agent-grants";

describe("isAgentGrantableCapability", () => {
	it("allows scoped entity reads (a specific type, or the * wildcard)", () => {
		expect(isAgentGrantableCapability("entities.read:io.brainstorm.notes/Note/v1")).toBe(true);
		expect(isAgentGrantableCapability("entities.read:*")).toBe(true);
	});

	it("refuses an unscoped entities.read (a grant must name its reach)", () => {
		expect(isAgentGrantableCapability("entities.read")).toBe(false);
	});

	it("allows propose-verb dispatch only", () => {
		expect(isAgentGrantableCapability("intents.dispatch:propose-task")).toBe(true);
		expect(isAgentGrantableCapability("intents.dispatch:propose-database")).toBe(true);
		expect(isAgentGrantableCapability("intents.dispatch:open")).toBe(false);
		expect(isAgentGrantableCapability("intents.dispatch:compose")).toBe(false);
		expect(isAgentGrantableCapability("intents.dispatch")).toBe(false);
	});

	it("allows the unscoped run/grounding set", () => {
		for (const cap of ["ai.use", "search.read", "search.hybrid", "roster.read"]) {
			expect(isAgentGrantableCapability(cap)).toBe(true);
		}
	});

	it("NEVER allows writes — the propose→approve invariant", () => {
		for (const cap of [
			"entities.write:*",
			"entities.write:io.brainstorm.notes/Note/v1",
			"entities.write",
		]) {
			expect(isAgentGrantableCapability(cap)).toBe(false);
		}
	});

	it("NEVER allows network / MCP / sharing / roster.write / credentials", () => {
		for (const cap of [
			"network.egress:https://evil.example",
			"network.ingress",
			"mcp.server:some-server",
			"sharing.share",
			"sharing.read",
			"roster.write",
			"credentials.read",
			"storage.kv",
			"ai.provider:openai",
		]) {
			expect(isAgentGrantableCapability(cap)).toBe(false);
		}
	});

	it("fails closed on junk", () => {
		for (const cap of ["", ":", "entities.read:", "search.read:extra", "unknown.verb"]) {
			expect(isAgentGrantableCapability(cap)).toBe(false);
		}
	});
});

describe("ledger-level enforcement (the choke point)", () => {
	it("refuses a non-grantable capability for an agent principal at grant time", async () => {
		const { CapabilityLedger, GrantedVia, AgentCapabilityRefusedError } = await import("./ledger");
		const { DataStores } = await import("../../shell/src/main/storage/data-stores");
		const { mkdtemp, rm } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");

		const dir = await mkdtemp(join(tmpdir(), "brainstorm-cap-agent-"));
		const stores = new DataStores(dir);
		try {
			const ledger = new CapabilityLedger(await stores.open("ledger"));
			const agent = "ed25519:0123456789abcdef";
			// Every alternate grant path funnels through here, so the policy holds
			// even for callers that never consult the vocabulary themselves.
			expect(() =>
				ledger.grant({
					appId: agent,
					capability: "network.egress",
					scope: "https://evil.example",
					grantedVia: GrantedVia.Runtime,
				}),
			).toThrow(AgentCapabilityRefusedError);
			expect(() =>
				ledger.grant({
					appId: agent,
					capability: "entities.write",
					scope: "*",
					grantedVia: GrantedVia.Runtime,
				}),
			).toThrow(AgentCapabilityRefusedError);
			expect(ledger.listActive(agent)).toHaveLength(0);

			// A grantable one still lands, and app principals are unaffected.
			expect(
				ledger.grant({ appId: agent, capability: "ai.use", grantedVia: GrantedVia.Runtime }).appId,
			).toBe(agent);
			expect(
				ledger.grant({
					appId: "io.brainstorm.notes",
					capability: "network.egress",
					scope: "https://ok.example",
					grantedVia: GrantedVia.Runtime,
				}).appId,
			).toBe("io.brainstorm.notes");
		} finally {
			stores.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
});
