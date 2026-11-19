import { BUILTIN_AGENT_MENTION_REF, BuiltinAgentUnavailableReason } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { englishT } from "../i18n";
import {
	AGENTS_MENTION_CAPABILITY,
	agentMentionCandidate,
	agentUnavailableMessageId,
	queryMayMatchAgent,
	resolveAgentMentionTarget,
} from "./agent-mention";

const AVAILABLE = { ref: BUILTIN_AGENT_MENTION_REF, displayName: "Agent", available: true };

describe("resolveAgentMentionTarget (Agent-13)", () => {
	it("is available only when the host says so", async () => {
		const mentionTarget = vi.fn(() => Promise.resolve(AVAILABLE));
		const target = await resolveAgentMentionTarget([AGENTS_MENTION_CAPABILITY], { mentionTarget });
		expect(target.available).toBe(true);
		expect(target.ref).toBe(BUILTIN_AGENT_MENTION_REF);
	});

	it("does not ask a host that would refuse — Chat without agents.mention", async () => {
		const mentionTarget = vi.fn(() => Promise.resolve(AVAILABLE));
		const target = await resolveAgentMentionTarget(["entities.read:*"], { mentionTarget });
		expect(mentionTarget).not.toHaveBeenCalled();
		expect(target).toMatchObject({
			available: false,
			reason: BuiltinAgentUnavailableReason.NoMentionPermission,
		});
	});

	it("asks when the runtime reports no capability list (main re-checks anyway)", async () => {
		const mentionTarget = vi.fn(() => Promise.resolve(AVAILABLE));
		expect((await resolveAgentMentionTarget(undefined, { mentionTarget })).available).toBe(true);
	});

	it("carries the host's reason through", async () => {
		const target = await resolveAgentMentionTarget(undefined, {
			mentionTarget: () =>
				Promise.resolve({
					ref: BUILTIN_AGENT_MENTION_REF,
					available: false,
					reason: BuiltinAgentUnavailableReason.NotInstalled,
				}),
		});
		expect(target).toMatchObject({
			available: false,
			reason: BuiltinAgentUnavailableReason.NotInstalled,
		});
	});

	it("fails closed: no service, a throw, or a malformed reply is UNAVAILABLE", async () => {
		expect((await resolveAgentMentionTarget(undefined, null)).available).toBe(false);
		expect((await resolveAgentMentionTarget(undefined, {})).available).toBe(false);
		const thrown = await resolveAgentMentionTarget(undefined, {
			mentionTarget: () => Promise.reject(new Error("Denied")),
		});
		expect(thrown.available).toBe(false);
		for (const reply of [null, "yes", { available: "true" }, { available: true, ref: "pk-x" }]) {
			const target = await resolveAgentMentionTarget(undefined, {
				mentionTarget: () => Promise.resolve(reply),
			});
			expect(target.available).toBe(false);
		}
	});

	it("every reason has its own hint, and an unknown one a generic hint", () => {
		const ids = Object.values(BuiltinAgentUnavailableReason).map(agentUnavailableMessageId);
		expect(new Set(ids).size).toBe(ids.length);
		expect(agentUnavailableMessageId(undefined)).toBe("agent.unavailable.generic");
	});
});

describe("agentMentionCandidate (Agent-13)", () => {
	const off = (reason?: BuiltinAgentUnavailableReason) => ({
		ref: BUILTIN_AGENT_MENTION_REF,
		displayName: "Agent",
		available: false,
		...(reason ? { reason } : {}),
	});

	it("offers a choosable @agent row when the host confirms it", () => {
		expect(agentMentionCandidate("ag", AVAILABLE, englishT)).toEqual({
			id: BUILTIN_AGENT_MENTION_REF,
			kind: "person",
			label: "Agent",
			description: "AI agent · replies in this channel",
		});
	});

	it("an unavailable agent is still LISTED — disabled, with the reason — never hidden", () => {
		const cases: [BuiltinAgentUnavailableReason | undefined, string][] = [
			[BuiltinAgentUnavailableReason.NotInstalled, "Install the Agent app to use @agent"],
			[
				BuiltinAgentUnavailableReason.NoAiPermission,
				"Allow the Agent app to use AI models to use @agent",
			],
			[
				BuiltinAgentUnavailableReason.NoMentionPermission,
				"Chat isn't allowed to invoke the agent in this vault",
			],
			[undefined, "@agent isn't available right now"],
		];
		for (const [reason, hint] of cases) {
			expect(agentMentionCandidate("", off(reason), englishT)).toMatchObject({
				id: BUILTIN_AGENT_MENTION_REF,
				disabled: true,
				description: hint,
			});
		}
	});

	it("matches the handle and the label, and steps aside for other names", () => {
		expect(queryMayMatchAgent("", englishT)).toBe(true);
		expect(queryMayMatchAgent("AGE", englishT)).toBe(true);
		expect(queryMayMatchAgent("ada", englishT)).toBe(false);
		expect(agentMentionCandidate("ada", AVAILABLE, englishT)).toBeNull();
		// A translated label still answers to the literal handle.
		const translated = (id: Parameters<typeof englishT>[0]) =>
			id === "agent.name" ? "Agente" : englishT(id);
		expect(queryMayMatchAgent("agent", translated)).toBe(true);
		expect(queryMayMatchAgent("agente", translated)).toBe(true);
	});
});
