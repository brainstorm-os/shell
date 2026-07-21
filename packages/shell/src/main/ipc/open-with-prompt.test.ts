import { type OpenWithCandidate, OpenWithDecisionKind } from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	MAX_PENDING,
	OPEN_WITH_PROMPT_CHANNEL,
	OpenWithPromptHost,
	type OpenWithPromptRequest,
	PROMPT_TIMEOUT_MS,
	type PromptSender,
} from "./open-with-prompt";

function fakeSender(): PromptSender & {
	sends: Array<{ channel: string; payload: OpenWithPromptRequest }>;
} {
	const sends: Array<{ channel: string; payload: OpenWithPromptRequest }> = [];
	return {
		send: (channel, payload) => sends.push({ channel, payload }),
		sends,
	};
}

const TWO_CANDS: readonly OpenWithCandidate[] = [
	{ appId: "web-browser", label: "Web Browser", kind: "primary" },
	{ appId: "bookmarks", label: "Bookmarks", kind: "secondary" },
];

describe("OpenWithPromptHost — without dashboard", () => {
	it("fails closed (Cancel) when no dashboard is set", async () => {
		const host = new OpenWithPromptHost();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const decision = await host.request("scheme:https", "https://example.com", TWO_CANDS);
		expect(decision.kind).toBe(OpenWithDecisionKind.Cancel);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("fails closed after `setDashboard(null)` (cleanup race)", async () => {
		const host = new OpenWithPromptHost();
		host.setDashboard(fakeSender());
		host.setDashboard(null);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const decision = await host.request("scheme:https", "https://example.com", TWO_CANDS);
		expect(decision.kind).toBe(OpenWithDecisionKind.Cancel);
		warn.mockRestore();
	});
});

describe("OpenWithPromptHost — happy path", () => {
	it("posts the prompt IPC carrying signature + uri + candidates + fresh requestId", async () => {
		const host = new OpenWithPromptHost();
		const sender = fakeSender();
		host.setDashboard(sender);
		const promise = host.request("scheme:https", "https://example.com", TWO_CANDS);
		expect(sender.sends).toHaveLength(1);
		const send = sender.sends[0];
		expect(send?.channel).toBe(OPEN_WITH_PROMPT_CHANNEL);
		const payload = send?.payload;
		expect(payload?.signature).toBe("scheme:https");
		expect(payload?.uri).toBe("https://example.com");
		expect(payload?.candidates).toEqual(TWO_CANDS);
		expect(payload?.requestId).toMatch(/^opw_/);
		host.handleReply({
			requestId: payload?.requestId ?? "",
			decision: { kind: OpenWithDecisionKind.Pick, appId: "bookmarks", remember: false },
		});
		const decision = await promise;
		expect(decision).toEqual({
			kind: OpenWithDecisionKind.Pick,
			appId: "bookmarks",
			remember: false,
		});
	});

	it("propagates Pick + remember=true verbatim", async () => {
		const host = new OpenWithPromptHost();
		const sender = fakeSender();
		host.setDashboard(sender);
		const promise = host.request("ext:pdf", "/tmp/x.pdf", TWO_CANDS);
		const requestId = sender.sends[0]?.payload.requestId ?? "";
		host.handleReply({
			requestId,
			decision: { kind: OpenWithDecisionKind.Pick, appId: "web-browser", remember: true },
		});
		const decision = await promise;
		expect(decision).toEqual({
			kind: OpenWithDecisionKind.Pick,
			appId: "web-browser",
			remember: true,
		});
	});

	it("propagates Cancel verbatim", async () => {
		const host = new OpenWithPromptHost();
		const sender = fakeSender();
		host.setDashboard(sender);
		const promise = host.request("scheme:mailto", "mailto:a@b.com", TWO_CANDS);
		const requestId = sender.sends[0]?.payload.requestId ?? "";
		host.handleReply({ requestId, decision: { kind: OpenWithDecisionKind.Cancel } });
		const decision = await promise;
		expect(decision.kind).toBe(OpenWithDecisionKind.Cancel);
	});

	it("distinct signatures mint unique requestIds (no cross-resolution)", async () => {
		const host = new OpenWithPromptHost();
		const sender = fakeSender();
		host.setDashboard(sender);
		const p1 = host.request("scheme:https", "https://a", TWO_CANDS);
		const p2 = host.request("ext:pdf", "/tmp/x.pdf", TWO_CANDS);
		const id1 = sender.sends[0]?.payload.requestId ?? "";
		const id2 = sender.sends[1]?.payload.requestId ?? "";
		expect(id1).not.toBe(id2);
		host.handleReply({
			requestId: id2,
			decision: { kind: OpenWithDecisionKind.Pick, appId: "preview", remember: false },
		});
		host.handleReply({ requestId: id1, decision: { kind: OpenWithDecisionKind.Cancel } });
		expect((await p1).kind).toBe(OpenWithDecisionKind.Cancel);
		expect(await p2).toEqual({
			kind: OpenWithDecisionKind.Pick,
			appId: "preview",
			remember: false,
		});
	});

	it("resolves all pending requests with Cancel when the dashboard goes away", async () => {
		const host = new OpenWithPromptHost();
		const sender = fakeSender();
		host.setDashboard(sender);
		const p1 = host.request("scheme:https", "https://a", TWO_CANDS);
		const p2 = host.request("ext:pdf", "/tmp/x.pdf", TWO_CANDS);
		host.setDashboard(null);
		expect((await p1).kind).toBe(OpenWithDecisionKind.Cancel);
		expect((await p2).kind).toBe(OpenWithDecisionKind.Cancel);
	});

	it("ignores a reply for an unknown / duplicate requestId", async () => {
		const host = new OpenWithPromptHost();
		const sender = fakeSender();
		host.setDashboard(sender);
		const promise = host.request("scheme:https", "https://a", TWO_CANDS);
		const requestId = sender.sends[0]?.payload.requestId ?? "";
		host.handleReply({
			requestId: "opw_unknown",
			decision: { kind: OpenWithDecisionKind.Pick, appId: "x", remember: false },
		});
		host.handleReply({
			requestId,
			decision: { kind: OpenWithDecisionKind.Pick, appId: "web-browser", remember: false },
		});
		host.handleReply({ requestId, decision: { kind: OpenWithDecisionKind.Cancel } });
		expect(await promise).toEqual({
			kind: OpenWithDecisionKind.Pick,
			appId: "web-browser",
			remember: false,
		});
	});
});

describe("OpenWithPromptHost — per-signature dedup", () => {
	it("a second request for an in-flight signature resolves to the same decision", async () => {
		const host = new OpenWithPromptHost();
		const sender = fakeSender();
		host.setDashboard(sender);
		const p1 = host.request("scheme:https", "https://a", TWO_CANDS);
		const p2 = host.request("scheme:https", "https://b", TWO_CANDS);
		expect(sender.sends).toHaveLength(1);
		const requestId = sender.sends[0]?.payload.requestId ?? "";
		host.handleReply({
			requestId,
			decision: { kind: OpenWithDecisionKind.Pick, appId: "bookmarks", remember: true },
		});
		const a = await p1;
		const b = await p2;
		expect(a).toEqual({
			kind: OpenWithDecisionKind.Pick,
			appId: "bookmarks",
			remember: true,
		});
		expect(b).toEqual(a);
	});

	it("a second request after the first resolves mints a new prompt", async () => {
		const host = new OpenWithPromptHost();
		const sender = fakeSender();
		host.setDashboard(sender);
		const p1 = host.request("scheme:https", "https://a", TWO_CANDS);
		const id1 = sender.sends[0]?.payload.requestId ?? "";
		host.handleReply({
			requestId: id1,
			decision: { kind: OpenWithDecisionKind.Pick, appId: "web-browser", remember: false },
		});
		await p1;
		const p2 = host.request("scheme:https", "https://b", TWO_CANDS);
		expect(sender.sends).toHaveLength(2);
		const id2 = sender.sends[1]?.payload.requestId ?? "";
		expect(id2).not.toBe(id1);
		host.handleReply({ requestId: id2, decision: { kind: OpenWithDecisionKind.Cancel } });
		expect((await p2).kind).toBe(OpenWithDecisionKind.Cancel);
	});
});

describe("OpenWithPromptHost — timeout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("an unanswered request resolves to Cancel after PROMPT_TIMEOUT_MS", async () => {
		const host = new OpenWithPromptHost();
		const sender = fakeSender();
		host.setDashboard(sender);
		const promise = host.request("scheme:https", "https://a", TWO_CANDS);
		await vi.advanceTimersByTimeAsync(PROMPT_TIMEOUT_MS);
		expect((await promise).kind).toBe(OpenWithDecisionKind.Cancel);
	});

	it("a reply before the timeout clears the timer (no double-resolution)", async () => {
		const host = new OpenWithPromptHost();
		const sender = fakeSender();
		host.setDashboard(sender);
		const promise = host.request("scheme:https", "https://a", TWO_CANDS);
		const requestId = sender.sends[0]?.payload.requestId ?? "";
		host.handleReply({
			requestId,
			decision: { kind: OpenWithDecisionKind.Pick, appId: "web-browser", remember: false },
		});
		await vi.advanceTimersByTimeAsync(PROMPT_TIMEOUT_MS * 2);
		expect(await promise).toEqual({
			kind: OpenWithDecisionKind.Pick,
			appId: "web-browser",
			remember: false,
		});
	});
});

describe("OpenWithPromptHost — pending cap", () => {
	it("rejects the newest request with Cancel when the queue is full", async () => {
		const host = new OpenWithPromptHost();
		const sender = fakeSender();
		host.setDashboard(sender);
		const pending = [] as Array<Promise<unknown>>;
		for (let i = 0; i < MAX_PENDING; i++) {
			pending.push(host.request(`scheme:custom-${i}`, `custom-${i}:`, TWO_CANDS));
		}
		expect(sender.sends).toHaveLength(MAX_PENDING);
		const overflow = host.request("scheme:overflow", "overflow:", TWO_CANDS);
		expect(((await overflow) as { kind: OpenWithDecisionKind }).kind).toBe(
			OpenWithDecisionKind.Cancel,
		);
		expect(sender.sends).toHaveLength(MAX_PENDING);
		host.setDashboard(null);
		for (const p of pending) await p;
	});

	it("resolving an entry frees its slot so the next request succeeds", async () => {
		const host = new OpenWithPromptHost();
		const sender = fakeSender();
		host.setDashboard(sender);
		const pending: Array<Promise<unknown>> = [];
		for (let i = 0; i < MAX_PENDING; i++) {
			pending.push(host.request(`scheme:custom-${i}`, `custom-${i}:`, TWO_CANDS));
		}
		const firstId = sender.sends[0]?.payload.requestId ?? "";
		host.handleReply({
			requestId: firstId,
			decision: { kind: OpenWithDecisionKind.Pick, appId: "x", remember: false },
		});
		await pending[0];
		const fresh = host.request("scheme:new", "new:", TWO_CANDS);
		expect(sender.sends).toHaveLength(MAX_PENDING + 1);
		const newId = sender.sends[MAX_PENDING]?.payload.requestId ?? "";
		host.handleReply({ requestId: newId, decision: { kind: OpenWithDecisionKind.Cancel } });
		expect(((await fresh) as { kind: OpenWithDecisionKind }).kind).toBe(OpenWithDecisionKind.Cancel);
		host.setDashboard(null);
		for (const p of pending.slice(1)) await p;
	});
});
