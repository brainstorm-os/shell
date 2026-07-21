/**
 * In-process proof of the `ai` broker path (CLAUDE.md §4): an envelope is
 * dispatched through a real `Broker` with a capability checker, routed to
 * the `ai` service handler, and on to a registered provider — and a caller
 * lacking `ai.use` is denied before the handler runs.
 */

import { type AiGenerateResult, MessageRole } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { Broker } from "../../ipc/broker";
import { makeAiServiceHandler } from "./ai-service";
import type { ModelProvider } from "./provider";
import { ProviderRegistry } from "./provider-registry";

const result: AiGenerateResult = {
	content: "hi from the model",
	provider: "ollama",
	model: "llama3.2",
};

function provider(): ModelProvider {
	return { id: "ollama", generate: vi.fn(async () => result) };
}

function envelope(app: string, caps: string[]) {
	return {
		v: 1,
		msg: "m1",
		app,
		service: "ai",
		method: "generate",
		args: [{ messages: [{ role: MessageRole.User, content: "Hi" }] }],
		caps,
	};
}

function brokerWithAi(grantedTo: Record<string, Set<string>>): Broker {
	const reg = new ProviderRegistry();
	reg.register(provider());
	const services = new Map([["ai", makeAiServiceHandler({ getProvider: (id) => reg.get(id) })]]);
	return new Broker({
		services,
		checkCapability: (app, _svc, _method, caps) => caps.every((c) => grantedTo[app]?.has(c) ?? false),
	});
}

describe("ai broker path", () => {
	it("routes a granted ai.generate envelope to the provider", async () => {
		const broker = brokerWithAi({ "io.brainstorm.agent": new Set(["ai.use"]) });
		const reply = await broker.dispatch(envelope("io.brainstorm.agent", ["ai.use"]), "wc-1");
		expect(reply.ok).toBe(true);
		if (reply.ok) expect(reply.value).toEqual(result);
	});

	it("denies a caller without ai.use before the handler runs", async () => {
		const broker = brokerWithAi({ "io.brainstorm.agent": new Set() });
		const reply = await broker.dispatch(envelope("io.brainstorm.agent", ["ai.use"]), "wc-1");
		expect(reply.ok).toBe(false);
		if (!reply.ok) expect(reply.error.kind).toBe("CapabilityDenied");
	});
});
