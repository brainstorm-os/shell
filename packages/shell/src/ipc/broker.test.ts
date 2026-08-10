import { describe, expect, it, vi } from "vitest";
import { Broker, type ServiceHandler } from "./broker";
import { ENVELOPE_PROTOCOL_VERSION, makeEnvelope } from "./envelope";

function mkEnvelope(over: Partial<Parameters<typeof makeEnvelope>[0]> = {}) {
	return makeEnvelope({
		msg: "m1",
		app: "io.example.app",
		service: "storage",
		method: "ping",
		args: [],
		caps: [],
		...over,
	});
}

describe("Broker.dispatch", () => {
	it("routes to the registered service handler and returns its value", async () => {
		const handler: ServiceHandler = (envelope) => ({ pong: envelope.args[0] });
		const broker = new Broker({ services: new Map([["storage", handler]]) });

		const reply = await broker.dispatch(mkEnvelope({ args: [42] }), "test-source");

		expect(reply.ok).toBe(true);
		expect(reply.ok === true && reply.value).toEqual({ pong: 42 });
	});

	it("rejects malformed envelopes with kind=Invalid", async () => {
		const broker = new Broker({ services: new Map() });
		const reply = await broker.dispatch({ wrong: "shape" }, "src");
		expect(reply.ok).toBe(false);
		expect(reply.ok === false && reply.error.kind).toBe("Invalid");
	});

	it("preserves the msg id when the envelope is malformed but has one", async () => {
		const broker = new Broker({ services: new Map() });
		const reply = await broker.dispatch({ v: 1, msg: "preserved" }, "src");
		expect(reply.msg).toBe("preserved");
	});

	it("returns 'unknown' msg when the envelope lacks one entirely", async () => {
		const broker = new Broker({ services: new Map() });
		const reply = await broker.dispatch({}, "src");
		expect(reply.msg).toBe("unknown");
	});

	it("returns Unavailable when the target service is not registered", async () => {
		const broker = new Broker({ services: new Map() });
		const reply = await broker.dispatch(mkEnvelope({ service: "entities" }), "src");
		expect(reply.ok).toBe(false);
		expect(reply.ok === false && reply.error.kind).toBe("Unavailable");
	});

	it("returns Invalid when the app identity verifier rejects", async () => {
		const broker = new Broker({
			services: new Map([["storage", () => "ok"]]),
			verifyAppIdentity: () => false,
		});
		const reply = await broker.dispatch(mkEnvelope(), "src");
		expect(reply.ok).toBe(false);
		expect(reply.ok === false && reply.error.kind).toBe("Invalid");
	});

	it("returns CapabilityDenied when the capability check fails", async () => {
		const broker = new Broker({
			services: new Map([["storage", () => "ok"]]),
			checkCapability: () => false,
		});
		const reply = await broker.dispatch(mkEnvelope(), "src");
		expect(reply.ok).toBe(false);
		expect(reply.ok === false && reply.error.kind).toBe("CapabilityDenied");
	});

	it("captures thrown handler errors as EnvelopeReplyError", async () => {
		class NotFoundError extends Error {
			constructor() {
				super("nope");
				this.name = "NotFound";
			}
		}
		const broker = new Broker({
			services: new Map([
				[
					"storage",
					() => {
						throw new NotFoundError();
					},
				],
			]),
		});
		const reply = await broker.dispatch(mkEnvelope(), "src");
		expect(reply.ok).toBe(false);
		expect(reply.ok === false && reply.error.kind).toBe("NotFound");
		expect(reply.ok === false && reply.error.message).toBe("nope");
	});

	it("captures non-Error throws too", async () => {
		const broker = new Broker({
			services: new Map([
				[
					"storage",
					() => {
						throw "string-error"; // eslint-disable-line @typescript-eslint/no-throw-literal
					},
				],
			]),
		});
		const reply = await broker.dispatch(mkEnvelope(), "src");
		expect(reply.ok).toBe(false);
		expect(reply.ok === false && reply.error.message).toBe("string-error");
	});

	it("registerService/unregisterService updates the routing table", async () => {
		const broker = new Broker({ services: new Map() });
		broker.registerService("storage", () => "first");
		const r1 = await broker.dispatch(mkEnvelope(), "src");
		expect(r1.ok === true && r1.value).toBe("first");
		broker.unregisterService("storage");
		const r2 = await broker.dispatch(mkEnvelope(), "src");
		expect(r2.ok === false && r2.error.kind).toBe("Unavailable");
	});

	it("passes source to the identity verifier", async () => {
		const verifier = vi.fn().mockReturnValue(true);
		const broker = new Broker({
			services: new Map([["storage", () => "ok"]]),
			verifyAppIdentity: verifier,
		});
		await broker.dispatch(mkEnvelope(), { renderer: 42 });
		expect(verifier).toHaveBeenCalledWith("io.example.app", { renderer: 42 });
	});

	it("passes the declared caps to the capability checker", async () => {
		const checker = vi.fn().mockReturnValue(true);
		const broker = new Broker({
			services: new Map([["storage", () => "ok"]]),
			checkCapability: checker,
		});
		await broker.dispatch(mkEnvelope({ caps: ["storage.kv"] }), "src");
		expect(checker).toHaveBeenCalledWith("io.example.app", "storage", "ping", ["storage.kv"]);
	});

	it("returns the canonical protocol version on every reply", async () => {
		const broker = new Broker({ services: new Map([["storage", () => "v"]]) });
		const ok = await broker.dispatch(mkEnvelope(), "src");
		expect(ok.v).toBe(ENVELOPE_PROTOCOL_VERSION);
		const bad = await broker.dispatch({}, "src");
		expect(bad.v).toBe(ENVELOPE_PROTOCOL_VERSION);
	});

	// ── Stage 4 enforcement ────────────────────────────────────────────────

	it("fail-closed: capability check throwing yields Unavailable, not approval", async () => {
		const broker = new Broker({
			services: new Map([["storage", () => "ok"]]),
			checkCapability: () => {
				throw new Error("ledger gone");
			},
		});
		const reply = await broker.dispatch(mkEnvelope(), "src");
		expect(reply.ok).toBe(false);
		expect(reply.ok === false && reply.error.kind).toBe("Unavailable");
		expect(reply.ok === false && reply.error.message).toMatch(/ledger/);
	});

	it("backpressure: per-app pending queue drops oldest when full", async () => {
		// Use a tiny queue depth so the test is fast + deterministic.
		let releaseFirst!: () => void;
		const firstStarted = new Promise<void>((r) => {
			releaseFirst = r;
		});

		const handlerCalls: string[] = [];
		const handler: ServiceHandler = async (envelope) => {
			handlerCalls.push(envelope.msg);
			if (envelope.msg === "old") {
				// First request blocks until we release it.
				await firstStarted;
			}
			return envelope.msg;
		};
		const broker = new Broker({
			services: new Map([["storage", handler]]),
			maxPendingPerApp: 1,
		});

		const oldPromise = broker.dispatch(mkEnvelope({ msg: "old" }), "src");
		// "new" request: enters the queue, evicts "old", proceeds.
		const newPromise = broker.dispatch(mkEnvelope({ msg: "new" }), "src");
		releaseFirst();

		const newReply = await newPromise;
		const oldReply = await oldPromise;
		expect(newReply.ok).toBe(true);
		expect(newReply.ok === true && newReply.value).toBe("new");
		expect(oldReply.ok).toBe(false);
		expect(oldReply.ok === false && oldReply.error.kind).toBe("Unavailable");
		expect(oldReply.ok === false && oldReply.error.message).toMatch(/backpressure/);
	});

	it("backpressure is per-app: app A's queue does not affect app B", async () => {
		let releaseA!: () => void;
		const aStarted = new Promise<void>((r) => {
			releaseA = r;
		});
		const handler: ServiceHandler = async (envelope) => {
			if (envelope.app === "a") {
				await aStarted;
			}
			return envelope.msg;
		};
		const broker = new Broker({
			services: new Map([["storage", handler]]),
			maxPendingPerApp: 1,
		});

		const a1 = broker.dispatch(mkEnvelope({ app: "a", msg: "a1" }), "src-a");
		const b1 = broker.dispatch(mkEnvelope({ app: "b", msg: "b1" }), "src-b");
		// b1 should NOT be dropped — it's a different app.
		releaseA();
		const [aReply, bReply] = await Promise.all([a1, b1]);
		expect(aReply.ok).toBe(true);
		expect(bReply.ok).toBe(true);
	});

	it("onDenied fires for every denial with the right kind", async () => {
		const events: string[] = [];
		const broker = new Broker({
			services: new Map(),
			checkCapability: () => false,
			onDenied: (e) => events.push(`${e.kind}:${e.service}.${e.method}`),
		});
		await broker.dispatch(mkEnvelope({ service: "storage", method: "ping" }), "src");
		await broker.dispatch({} as unknown, "src");
		await broker.dispatch(mkEnvelope({ service: "nonexistent" }), "src");
		expect(events).toContain("CapabilityDenied:storage.ping");
		expect(events.some((e) => e.startsWith("Invalid:"))).toBe(true);
	});

	it("onDenied does NOT fire on a successful dispatch", async () => {
		const events: string[] = [];
		const broker = new Broker({
			services: new Map([["storage", () => "ok"]]),
			onDenied: (e) => events.push(e.kind),
		});
		const reply = await broker.dispatch(mkEnvelope(), "src");
		expect(reply.ok).toBe(true);
		expect(events).toEqual([]);
	});
});
