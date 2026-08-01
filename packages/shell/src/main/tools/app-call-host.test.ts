/**
 * AppCallHost (Tool-1) — the reverse channel's contract, incl. THE new
 * invariant: only the renderer a call was sent to may answer it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	APP_CALL_ARGS_BYTES_MAX,
	APP_CALL_RESULT_BYTES_MAX,
	APP_CALL_TIMEOUT_MS,
	AppCallFailure,
	AppCallHost,
	type AppCallRequest,
	MAX_PENDING_PER_APP,
	TOOLS_CALL_CHANNEL,
} from "./app-call-host";

function sender() {
	const sent: Array<{ channel: string; payload: AppCallRequest }> = [];
	return {
		sent,
		send(channel: string, payload: AppCallRequest) {
			sent.push({ channel, payload });
		},
	};
}

describe("AppCallHost (Tool-1)", () => {
	let host: AppCallHost;
	beforeEach(() => {
		host = new AppCallHost();
	});
	afterEach(() => {
		host.dispose();
		vi.useRealTimers();
	});

	it("round-trips a call to the attached renderer and back", async () => {
		const s = sender();
		host.attachApp("io.example.a", 1, s);
		const call = host.call("io.example.a", "rewrite", { text: "hi" });
		expect(s.sent).toHaveLength(1);
		expect(s.sent[0]?.channel).toBe(TOOLS_CALL_CHANNEL);
		const { callId, tool, args } = s.sent[0]?.payload as AppCallRequest;
		expect(tool).toBe("rewrite");
		expect(args).toEqual({ text: "hi" });
		host.handleResult("io.example.a", { callId, ok: true, value: { text: "HI" } });
		await expect(call).resolves.toEqual({ ok: true, value: { text: "HI" } });
		expect(host.pendingFor("io.example.a")).toBe(0);
	});

	it("THE invariant: a reply from a different verified app is dropped, the right app still answers", async () => {
		const s = sender();
		host.attachApp("io.example.a", 1, s);
		const call = host.call("io.example.a", "rewrite", {});
		const { callId } = s.sent[0]?.payload as AppCallRequest;
		// A hostile sibling app that somehow learned the callId:
		host.handleResult("io.example.evil", { callId, ok: true, value: "spoofed" });
		expect(host.dropCounters().wrongSender).toBe(1);
		expect(host.pendingFor("io.example.a")).toBe(1); // still pending
		host.handleResult("io.example.a", { callId, ok: true, value: "real" });
		await expect(call).resolves.toEqual({ ok: true, value: "real" });
	});

	it("drops unknown call ids and malformed replies silently, with counters", () => {
		host.handleResult("io.example.a", { callId: "apc_nope", ok: true, value: 1 });
		host.handleResult("io.example.a", { ok: true });
		expect(host.dropCounters()).toMatchObject({ unknownCallId: 1, malformedReply: 1 });
	});

	it("resolves Unavailable when no renderer is attached", async () => {
		await expect(host.call("io.example.a", "t", {})).resolves.toEqual({
			ok: false,
			reason: AppCallFailure.Unavailable,
		});
	});

	it("drains pending calls to Unavailable on detach (an answer, not an error)", async () => {
		const s = sender();
		host.attachApp("io.example.a", 1, s);
		const call = host.call("io.example.a", "t", {});
		host.detachApp("io.example.a", 1);
		await expect(call).resolves.toEqual({ ok: false, reason: AppCallFailure.Unavailable });
	});

	it("keeps pending calls alive while ANY tab of the app survives", async () => {
		const t1 = sender();
		const t2 = sender();
		host.attachApp("io.example.a", 1, t1);
		host.attachApp("io.example.a", 2, t2);
		const call = host.call("io.example.a", "t", {}); // sent to tab 2 (most recent)
		expect(t2.sent).toHaveLength(1);
		host.detachApp("io.example.a", 2);
		// Tab 1 survives — the call must NOT drain...
		expect(host.pendingFor("io.example.a")).toBe(1);
		// ...and tab 1 (same app identity) may still answer it.
		const { callId } = t2.sent[0]?.payload as AppCallRequest;
		host.handleResult("io.example.a", { callId, ok: true, value: 7 });
		await expect(call).resolves.toEqual({ ok: true, value: 7 });
	});

	it("REJECTS on timeout (the WorkerBridge asymmetry, preserved)", async () => {
		vi.useFakeTimers();
		const s = sender();
		host.attachApp("io.example.a", 1, s);
		const call = host.call("io.example.a", "t", {});
		const assertion = expect(call).rejects.toThrow(/timed out/);
		vi.advanceTimersByTime(APP_CALL_TIMEOUT_MS + 1);
		await assertion;
		expect(host.pendingFor("io.example.a")).toBe(0);
	});

	it("answers Busy past the per-app pending cap; other apps unaffected", async () => {
		const a = sender();
		const b = sender();
		host.attachApp("io.example.a", 1, a);
		host.attachApp("io.example.b", 2, b);
		const calls = Array.from({ length: MAX_PENDING_PER_APP }, () =>
			host.call("io.example.a", "t", {}),
		);
		await expect(host.call("io.example.a", "t", {})).resolves.toEqual({
			ok: false,
			reason: AppCallFailure.Busy,
		});
		const other = host.call("io.example.b", "t", {});
		expect(b.sent).toHaveLength(1);
		host.detachApp("io.example.a", 1);
		host.detachApp("io.example.b", 2);
		await Promise.all([...calls, other]);
	});

	it("caps argument and reply payloads (TooLarge, never a partial delivery)", async () => {
		const s = sender();
		host.attachApp("io.example.a", 1, s);
		const big = "x".repeat(APP_CALL_ARGS_BYTES_MAX + 1);
		await expect(host.call("io.example.a", "t", { big })).resolves.toEqual({
			ok: false,
			reason: AppCallFailure.TooLarge,
		});
		const call = host.call("io.example.a", "t", {});
		const { callId } = s.sent[0]?.payload as AppCallRequest;
		host.handleResult("io.example.a", {
			callId,
			ok: true,
			value: "y".repeat(APP_CALL_RESULT_BYTES_MAX + 1),
		});
		await expect(call).resolves.toEqual({ ok: false, reason: AppCallFailure.TooLarge });
	});

	it("clamps provider error messages", async () => {
		const s = sender();
		host.attachApp("io.example.a", 1, s);
		const call = host.call("io.example.a", "t", {});
		const { callId } = s.sent[0]?.payload as AppCallRequest;
		host.handleResult("io.example.a", { callId, ok: false, error: "e".repeat(2000) });
		const result = await call;
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe(AppCallFailure.Provider);
			expect(result.message?.length).toBe(500);
		}
	});

	it("a renderer destroyed mid-call settles Unavailable, not a raw throw", async () => {
		host.attachApp("io.example.a", 1, {
			send() {
				throw new TypeError("Object has been destroyed");
			},
		});
		await expect(host.call("io.example.a", "t", {})).resolves.toEqual({
			ok: false,
			reason: AppCallFailure.Unavailable,
		});
		expect(host.pendingFor("io.example.a")).toBe(0);
	});

	it("refuses to make a reserved platform principal callable", async () => {
		host.attachApp("shell", 1, sender());
		await expect(host.call("shell", "t", {})).resolves.toEqual({
			ok: false,
			reason: AppCallFailure.Unavailable,
		});
	});

	it("dispose settles everything Unavailable", async () => {
		const s = sender();
		host.attachApp("io.example.a", 1, s);
		const calls = [host.call("io.example.a", "t", {}), host.call("io.example.a", "u", {})];
		host.dispose();
		await expect(Promise.all(calls)).resolves.toEqual([
			{ ok: false, reason: AppCallFailure.Unavailable },
			{ ok: false, reason: AppCallFailure.Unavailable },
		]);
	});
});
