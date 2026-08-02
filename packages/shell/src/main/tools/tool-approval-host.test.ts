/**
 * Tool-8 — the shell-owned approval host.
 *
 * Every path that is not an explicit yes must resolve NO. That is the whole
 * contract: this replaced a caller-asserted boolean precisely because "assume
 * approved" was reachable, so a fail-open here would put the hole straight
 * back.
 */

import {
	AppToolEffect,
	type AppToolRecord,
	AppToolSurface,
	appToolId,
} from "@brainstorm-os/sdk-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	TOOL_APPROVAL_PROMPT_CHANNEL,
	ToolApprovalHost,
	ToolApprovalReason,
	type ToolApprovalRequest,
} from "./tool-approval-host";

const TOOL: AppToolRecord = {
	id: appToolId("io.example.p", "publish"),
	appId: "io.example.p",
	name: "publish",
	title: "Publish",
	description: "Send it somewhere.",
	effect: AppToolEffect.External,
	appliesTo: [],
	surfaces: [AppToolSurface.Menu],
	input: [],
	registeredAt: 1,
};

function dashboard() {
	const sent: ToolApprovalRequest[] = [];
	return { sent, send: (_c: string, p: ToolApprovalRequest) => void sent.push(p) };
}

const ask = (
	host: ToolApprovalHost,
	over: Partial<Parameters<ToolApprovalHost["request"]>[0]> = {},
) =>
	host.request({
		callerAppId: "io.brainstorm.notes",
		tool: TOOL,
		providerLabel: "Provider",
		reason: ToolApprovalReason.FirstUse,
		agentInitiated: false,
		...over,
	});

afterEach(() => vi.useRealTimers());

describe("ToolApprovalHost", () => {
	it("resolves NO when there is no dashboard to ask", async () => {
		await expect(ask(new ToolApprovalHost())).resolves.toBe(false);
	});

	it("posts the prompt and resolves the human's answer", async () => {
		const host = new ToolApprovalHost();
		const dash = dashboard();
		host.setDashboard(dash);
		const pending = ask(host);
		expect(dash.sent).toHaveLength(1);
		const request = dash.sent[0];
		expect(request).toMatchObject({
			toolId: TOOL.id,
			toolTitle: "Publish",
			providerLabel: "Provider",
			reason: ToolApprovalReason.FirstUse,
			agentInitiated: false,
		});
		host.handleReply({ requestId: request?.requestId, accept: true });
		await expect(pending).resolves.toBe(true);
	});

	it("treats anything that is not an explicit true as NO", async () => {
		for (const accept of [false, undefined, null, 1, "true", {}]) {
			const host = new ToolApprovalHost();
			const dash = dashboard();
			host.setDashboard(dash);
			const pending = ask(host);
			host.handleReply({ requestId: dash.sent[0]?.requestId, accept });
			await expect(pending, JSON.stringify(accept)).resolves.toBe(false);
		}
	});

	it("ignores a reply for an unknown or malformed request id", async () => {
		const host = new ToolApprovalHost();
		const dash = dashboard();
		host.setDashboard(dash);
		const pending = ask(host);
		// A late or forged reply must not resolve someone else's prompt.
		host.handleReply({ requestId: "tap_not-a-real-id", accept: true });
		host.handleReply({ requestId: 42, accept: true });
		host.handleReply({});
		expect(host.pendingCount()).toBe(1);
		host.handleReply({ requestId: dash.sent[0]?.requestId, accept: true });
		await expect(pending).resolves.toBe(true);
	});

	it("ignores a duplicate reply", async () => {
		const host = new ToolApprovalHost();
		const dash = dashboard();
		host.setDashboard(dash);
		const pending = ask(host);
		const id = dash.sent[0]?.requestId;
		host.handleReply({ requestId: id, accept: true });
		host.handleReply({ requestId: id, accept: false });
		await expect(pending).resolves.toBe(true);
		expect(host.pendingCount()).toBe(0);
	});

	it("refuses everything in flight when the dashboard goes away", async () => {
		const host = new ToolApprovalHost();
		host.setDashboard(dashboard());
		const pending = ask(host);
		host.setDashboard(null);
		await expect(pending).resolves.toBe(false);
	});

	it("refuses when the renderer throws mid-send", async () => {
		const host = new ToolApprovalHost();
		host.setDashboard({
			send: () => {
				throw new Error("renderer destroyed");
			},
		});
		await expect(ask(host)).resolves.toBe(false);
		expect(host.pendingCount()).toBe(0);
	});

	it("expires an unanswered prompt as NO", async () => {
		vi.useFakeTimers();
		const host = new ToolApprovalHost();
		host.setDashboard(dashboard());
		const pending = ask(host);
		await vi.advanceTimersByTimeAsync(120_001);
		await expect(pending).resolves.toBe(false);
	});

	it("tells the prompt when an agent is behind the call", async () => {
		// "Your agent wants to…" is a materially different question from "you
		// clicked", so the dashboard has to be able to say so.
		const host = new ToolApprovalHost();
		const dash = dashboard();
		host.setDashboard(dash);
		void ask(host, { agentInitiated: true, reason: ToolApprovalReason.DeclarationChanged });
		expect(dash.sent[0]).toMatchObject({
			agentInitiated: true,
			reason: ToolApprovalReason.DeclarationChanged,
		});
	});

	it("uses the documented channel", () => {
		expect(TOOL_APPROVAL_PROMPT_CHANNEL).toBe("tools:approval-prompt");
	});
});
