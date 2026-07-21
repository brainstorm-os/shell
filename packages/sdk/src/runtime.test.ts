import type { AppHandshake } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import type { Bridge, BridgeReply } from "./bridge";
import { CapabilityDenied, Conflict, Invalid, NotFound, Unavailable } from "./errors";
import { decodeHandshake, encodeHandshake } from "./handshake";
import { LifecycleEmitter, buildRuntimeWithEmitter } from "./runtime";

function fakeBridge(replies: Array<BridgeReply | ((args: unknown[]) => BridgeReply)>): {
	bridge: Bridge;
	calls: Array<{ service: string; method: string; args: unknown[]; caps: string[] }>;
} {
	const calls: Array<{ service: string; method: string; args: unknown[]; caps: string[] }> = [];
	let i = 0;
	const bridge: Bridge = {
		app: "io.example.app",
		dispatch: async (envelope) => {
			calls.push(envelope);
			const next = replies[i++];
			if (!next) throw new Error("fakeBridge: no more replies queued");
			return typeof next === "function" ? next(envelope.args) : next;
		},
	};
	return { bridge, calls };
}

const handshake: AppHandshake = {
	app: { id: "io.example.app", version: "1.0.0", sdkVersion: "1" },
	capabilities: ["storage.kv", "credentials.read:self"],
	launch: { reason: "fresh" },
};

describe("buildRuntime", () => {
	it("exposes the handshake fields directly", () => {
		const { bridge } = fakeBridge([]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		expect(runtime.app.id).toBe("io.example.app");
		expect(runtime.capabilities).toEqual(["storage.kv", "credentials.read:self"]);
		expect(runtime.launch.reason).toBe("fresh");
	});

	it("storage.put dispatches a 'storage.put' envelope with storage.kv cap", async () => {
		const { bridge, calls } = fakeBridge([{ ok: true, value: undefined }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		await runtime.services.storage.put("k", { x: 1 });
		expect(calls[0]).toMatchObject({
			service: "storage",
			method: "put",
			caps: ["storage.kv"],
		});
		expect(calls[0]?.args[0]).toEqual({ key: "k", value: { x: 1 } });
	});

	it("storage.get unwraps the reply value", async () => {
		const { bridge } = fakeBridge([{ ok: true, value: { hello: "world" } }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		const value = await runtime.services.storage.get("k");
		expect(value).toEqual({ hello: "world" });
	});

	it("credentials.set base64-encodes the value over the wire", async () => {
		const { bridge, calls } = fakeBridge([{ ok: true, value: undefined }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		await runtime.services.credentials.set("api-key", new Uint8Array([1, 2, 3]));
		const args = calls[0]?.args[0] as { key: string; valueB64: string };
		expect(args.key).toBe("api-key");
		expect(args.valueB64).toBe("AQID"); // [1,2,3] base64
	});

	it("credentials.get base64-decodes the reply", async () => {
		const { bridge } = fakeBridge([{ ok: true, value: "AQID" }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		const value = await runtime.services.credentials.get("api-key");
		expect(Array.from(value ?? [])).toEqual([1, 2, 3]);
	});

	it("credentials.get returns null when the wire says null", async () => {
		const { bridge } = fakeBridge([{ ok: true, value: null }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		expect(await runtime.services.credentials.get("missing")).toBeNull();
	});

	it("identity.signPayload round-trips base64", async () => {
		const { bridge, calls } = fakeBridge([{ ok: true, value: "BQYH" }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		const sig = await runtime.services.identity.signPayload(new Uint8Array([1, 2, 3]));
		expect(Array.from(sig)).toEqual([5, 6, 7]);
		expect(calls[0]?.args[0]).toEqual({ payloadB64: "AQID" });
	});

	it("ui.notify carries the notification payload", async () => {
		const { bridge, calls } = fakeBridge([{ ok: true, value: undefined }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		await runtime.services.ui.notify({ title: "hi", body: "there", kind: "info" });
		expect(calls[0]?.args[0]).toEqual({ title: "hi", body: "there", kind: "info" });
		expect(calls[0]?.caps).toEqual(["notifications.post"]);
	});

	it("ui.openSearch stamps the search.open cap with the query payload (9.8.9)", async () => {
		const { bridge, calls } = fakeBridge([{ ok: true, value: undefined }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		await runtime.services.ui.openSearch({ query: "design" });
		expect(calls[0]?.service).toBe("ui");
		expect(calls[0]?.method).toBe("openSearch");
		expect(calls[0]?.args[0]).toEqual({ query: "design" });
		expect(calls[0]?.caps).toEqual(["search.open"]);
	});

	it("CapabilityDenied is reconstructed on the renderer side", async () => {
		const { bridge } = fakeBridge([
			{
				ok: false,
				error: {
					kind: "CapabilityDenied",
					message: "app lacks storage.kv",
					capability: "storage.kv",
				},
			},
		]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		try {
			await runtime.services.storage.put("k", 1);
			throw new Error("expected throw");
		} catch (error) {
			expect(error).toBeInstanceOf(CapabilityDenied);
			expect((error as CapabilityDenied).capability).toBe("storage.kv");
		}
	});

	it("NotFound carries kind + id details", async () => {
		const { bridge } = fakeBridge([
			{
				ok: false,
				error: { kind: "NotFound", message: "no such entity", kind_: "entity", id: "ent_x" },
			},
		]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		try {
			await runtime.services.storage.get("k");
			throw new Error("expected throw");
		} catch (error) {
			expect(error).toBeInstanceOf(NotFound);
		}
	});

	it("Unavailable / Invalid / Conflict round-trip through the error mapper", async () => {
		const cases: Array<["Unavailable" | "Invalid" | "Conflict", typeof Unavailable]> = [
			["Unavailable", Unavailable],
			["Invalid", Invalid],
			["Conflict", Conflict],
		];
		for (const [kind, ctor] of cases) {
			const { bridge } = fakeBridge([{ ok: false, error: { kind, message: `${kind} reason` } }]);
			const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
			await expect(runtime.services.storage.get("k")).rejects.toBeInstanceOf(ctor);
		}
	});

	it("Unknown error kinds throw a generic Error", async () => {
		const { bridge } = fakeBridge([{ ok: false, error: { kind: "WeirdNewKind", message: "?" } }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		try {
			await runtime.services.storage.get("k");
			throw new Error("expected throw");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).name).toBe("WeirdNewKind");
		}
	});

	it("files proxy dispatches through the broker with the scoped cap (9.10)", async () => {
		// Two replies queued: one for files.requestOpen, one for the
		// follow-up entities.get used as the live-proxy sanity check.
		const { bridge, calls } = fakeBridge([
			{ ok: true, value: [{ handleId: "tok_a", displayName: "a.txt" }] },
			{ ok: true, value: null },
		]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		const handles = await runtime.services.files.requestOpen();
		expect(handles).toEqual([{ handleId: "tok_a", displayName: "a.txt" }]);
		expect(calls[0]).toMatchObject({
			service: "files",
			method: "requestOpen",
			caps: ["files.read"],
		});
		await expect(runtime.services.entities.get("ent_x")).resolves.toBeNull();
		expect(calls[1]).toMatchObject({
			service: "entities",
			method: "get",
			args: [{ id: "ent_x" }],
			caps: [],
		});
	});

	it("import.run dispatches to the import service with no static cap (handler is authority)", async () => {
		const report = { created: 2, updated: 0, skipped: 0, failed: [] };
		const { bridge, calls } = fakeBridge([{ ok: true, value: report }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		const result = await runtime.services.import.run({
			format: "jsonl",
			text: '{"id":"1"}',
			targetType: "io.example/Note/v1",
		});
		expect(result).toEqual(report);
		expect(calls[0]).toMatchObject({
			service: "import",
			method: "run",
			args: [{ format: "jsonl", text: '{"id":"1"}', targetType: "io.example/Note/v1" }],
			caps: [],
		});
	});

	it("import.preview dispatches to the import service (no write, no static cap)", async () => {
		const preview = { columns: ["id", "title"], recordCount: 1, sample: [{ id: "1", title: "x" }] };
		const { bridge, calls } = fakeBridge([{ ok: true, value: preview }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		const result = await runtime.services.import.preview({
			format: "csv",
			text: "id,title\n1,x",
			targetType: "io.example/Note/v1",
		});
		expect(result).toEqual(preview);
		expect(calls[0]).toMatchObject({ service: "import", method: "preview", caps: [] });
	});

	it("export.serializeEntities dispatches read-only to the export service", async () => {
		const { bridge, calls } = fakeBridge([{ ok: true, value: '{"id":"ent_a"}' }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		const text = await runtime.services.export.serializeEntities({ ids: ["ent_a"], format: "json" });
		expect(text).toBe('{"id":"ent_a"}');
		expect(calls[0]).toMatchObject({ service: "export", method: "serializeEntities", caps: [] });
	});

	it("properties.list dispatches with properties.read cap and unwraps the snapshot", async () => {
		const snap = {
			properties: { prop_a: { key: "prop_a", name: "Title", icon: null, kind: "text" } },
			dictionaries: {},
		};
		const { bridge, calls } = fakeBridge([{ ok: true, value: snap }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		const result = await runtime.services.properties.list();
		expect(result).toEqual(snap);
		expect(calls[0]).toMatchObject({
			service: "properties",
			method: "list",
			args: [],
			caps: ["properties.read"],
		});
	});

	it("properties.setProperty dispatches with properties.write cap", async () => {
		const { bridge, calls } = fakeBridge([{ ok: true, value: undefined }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		const def = { key: "prop_a", name: "Title", icon: null, kind: "text" as const };
		// biome-ignore lint/suspicious/noExplicitAny: cast to satisfy the discriminated-union signature in this minimal-cap test
		await runtime.services.properties.setProperty(def as any);
		expect(calls[0]).toMatchObject({
			service: "properties",
			method: "setProperty",
			args: [{ def }],
			caps: ["properties.write"],
		});
	});

	it("properties.getProperty returns null when the shell replies null", async () => {
		const { bridge } = fakeBridge([{ ok: true, value: null }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		const result = await runtime.services.properties.getProperty("prop_missing");
		expect(result).toBeNull();
	});

	it("properties.removeDictionary dispatches { id } with properties.write cap", async () => {
		const { bridge, calls } = fakeBridge([{ ok: true, value: undefined }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		await runtime.services.properties.removeDictionary("dict_x");
		expect(calls[0]).toMatchObject({
			service: "properties",
			method: "removeDictionary",
			args: [{ id: "dict_x" }],
			caps: ["properties.write"],
		});
	});

	it("properties.onChange returns a no-op Subscription on the default proxy", () => {
		const { bridge } = fakeBridge([]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		const subscription = runtime.services.properties.onChange(() => {
			throw new Error("listener must not fire on the default no-op proxy");
		});
		expect(typeof subscription.unsubscribe).toBe("function");
		// Idempotent — unsubscribing twice must not throw.
		subscription.unsubscribe();
		subscription.unsubscribe();
	});

	it("vaultEntities.list dispatches with entities.read:* cap", async () => {
		const snapshot = { entities: [], links: [] };
		const { bridge, calls } = fakeBridge([{ ok: true, value: snapshot }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		const result = await runtime.services.vaultEntities.list();
		expect(result).toBe(snapshot);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			service: "vault-entities",
			method: "list",
			args: [],
			caps: ["entities.read:*"],
		});
	});

	it("vaultEntities.onChange returns a no-op Subscription on the default proxy", () => {
		const { bridge } = fakeBridge([]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		const subscription = runtime.services.vaultEntities.onChange(() => {
			throw new Error("listener must not fire on the default no-op proxy");
		});
		expect(typeof subscription.unsubscribe).toBe("function");
		subscription.unsubscribe();
		subscription.unsubscribe();
	});

	it("search.query dispatches with search.read cap and returns hits as-is", async () => {
		const hits = [
			{
				entityId: "ent_1",
				type: "io.brainstorm.notes/Note/v1",
				ownerAppId: "io.brainstorm.notes",
				title: "found me",
				snippet: "fragment around <mark>found</mark>",
				score: -1.23,
				updatedAt: 1737840000000,
			},
		];
		const { bridge, calls } = fakeBridge([{ ok: true, value: hits }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		const result = await runtime.services.search.query({ text: "found", limit: 25 });
		expect(result).toBe(hits);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			service: "search",
			method: "query",
			args: [{ text: "found", limit: 25 }],
			caps: ["search.read"],
		});
	});

	it("intents.dispatch forwards { verb, payload } and unwraps { handled, value }", async () => {
		const { bridge, calls } = fakeBridge([
			{ ok: true, value: { handled: true, value: { windowId: "main" } } },
		]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		const result = await runtime.services.intents.dispatch({
			verb: "open",
			payload: { entityId: "ent_1" },
		});
		expect(result).toEqual({ handled: true, value: { windowId: "main" } });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			service: "intents",
			method: "dispatch",
			args: [{ verb: "open", payload: { entityId: "ent_1" } }],
			caps: ["intents.dispatch:open"],
		});
	});

	it("intents.dispatch returns null when the bus returns null", async () => {
		const { bridge } = fakeBridge([{ ok: true, value: null }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		const result = await runtime.services.intents.dispatch({
			verb: "open",
			payload: { entityId: "ent_1" },
		});
		expect(result).toBeNull();
	});

	it("'ready' lifecycle event fires after construction", async () => {
		const { bridge } = fakeBridge([]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		const events: string[] = [];
		runtime.on("ready", (e) => {
			events.push(e.handshake.app.id);
		});
		await new Promise((r) => queueMicrotask(() => r(null)));
		expect(events).toEqual(["io.example.app"]);
	});

	it("emitter pushes suspend/resume/intent/capability-changed/close to handlers", async () => {
		const { bridge } = fakeBridge([]);
		const { runtime, emitter } = buildRuntimeWithEmitter({ handshake, bridge });
		const events: string[] = [];
		runtime.on("suspend", () => {
			events.push("suspend");
		});
		runtime.on("resume", () => {
			events.push("resume");
		});
		runtime.on("intent", (e) => {
			events.push(`intent:${e.intent.verb}`);
		});
		runtime.on("capability-changed", (e) => {
			events.push(`caps:${e.capabilities.length}`);
		});
		runtime.on("close", () => {
			events.push("close");
		});
		emitter.emit({ type: "suspend" });
		emitter.emit({ type: "resume" });
		emitter.emit({ type: "intent", intent: { verb: "open", payload: {}, source: "shell" } });
		emitter.emit({ type: "capability-changed", capabilities: ["x", "y"] });
		emitter.emit({ type: "close" });
		expect(events).toEqual(["suspend", "resume", "intent:open", "caps:2", "close"]);
	});

	it("subscription.unsubscribe stops further deliveries", () => {
		const { bridge } = fakeBridge([]);
		const { runtime, emitter } = buildRuntimeWithEmitter({ handshake, bridge });
		const fired: string[] = [];
		const sub = runtime.on("suspend", () => {
			fired.push("x");
		});
		emitter.emit({ type: "suspend" });
		sub.unsubscribe();
		emitter.emit({ type: "suspend" });
		expect(fired).toEqual(["x"]);
	});

	it("storage.uploadStreamed drives Begin → Chunk(loop) → Commit", async () => {
		const totalBytes = 5 * 1024; // exactly 5 chunks at the 1 KiB hint we'll fake
		const bytes = new Uint8Array(totalBytes);
		for (let i = 0; i < totalBytes; i++) bytes[i] = i & 0xff;

		const { bridge, calls } = fakeBridge([
			{ ok: true, value: { uploadToken: "up_t", chunkBytes: 1024 } },
			{ ok: true, value: { ok: true, receivedBytes: 1024 } },
			{ ok: true, value: { ok: true, receivedBytes: 2048 } },
			{ ok: true, value: { ok: true, receivedBytes: 3072 } },
			{ ok: true, value: { ok: true, receivedBytes: 4096 } },
			{ ok: true, value: { ok: true, receivedBytes: 5120 } },
			{
				ok: true,
				value: {
					url: "brainstorm://app-file/io.example.app/abc.png",
					hash: "abc",
					ext: ".png",
					size: totalBytes,
					mime: "image/png",
				},
			},
		]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		const progress: number[] = [];
		const file = await runtime.services.storage.uploadStreamed({
			name: "x.png",
			bytes,
			mime: "image/png",
			onProgress: (r) => progress.push(r),
		});
		expect(file.hash).toBe("abc");
		expect(calls.map((c) => c.method)).toEqual([
			"uploadBegin",
			"uploadChunk",
			"uploadChunk",
			"uploadChunk",
			"uploadChunk",
			"uploadChunk",
			"uploadCommit",
		]);
		expect(progress).toEqual([1024, 2048, 3072, 4096, 5120]);
		// First chunk envelope has seq 0; last has seq 4.
		expect((calls[1]?.args[0] as { seq: number }).seq).toBe(0);
		expect((calls[5]?.args[0] as { seq: number }).seq).toBe(4);
		// Every chunked-storage envelope rides `storage.kv`.
		for (const c of calls) expect(c.caps).toEqual(["storage.kv"]);
	});

	it("storage.uploadStreamed calls uploadAbort if a chunk rejects", async () => {
		const bytes = new Uint8Array(2048);
		const { bridge, calls } = fakeBridge([
			{ ok: true, value: { uploadToken: "up_t", chunkBytes: 1024 } },
			{ ok: false, error: { kind: "Invalid", message: "out-of-order seq" } },
			{ ok: true, value: undefined }, // uploadAbort cleanup
		]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		await expect(
			runtime.services.storage.uploadStreamed({ name: "x.png", bytes }),
		).rejects.toBeDefined();
		expect(calls.map((c) => c.method)).toEqual(["uploadBegin", "uploadChunk", "uploadAbort"]);
	});

	it("storage.uploadStreamed honours AbortSignal — aborts and rethrows", async () => {
		const bytes = new Uint8Array(4096);
		const controller = new AbortController();
		const { bridge, calls } = fakeBridge([
			{ ok: true, value: { uploadToken: "up_t", chunkBytes: 1024 } },
			() => {
				// Abort after the first chunk's reply lands. The wrapper checks
				// `signal.aborted` at the head of the next iteration.
				controller.abort(new Error("user cancelled"));
				return { ok: true, value: { ok: true, receivedBytes: 1024 } };
			},
			{ ok: true, value: undefined }, // uploadAbort
		]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		await expect(
			runtime.services.storage.uploadStreamed({
				name: "x.png",
				bytes,
				signal: controller.signal,
			}),
		).rejects.toThrow("user cancelled");
		expect(calls.at(-1)?.method).toBe("uploadAbort");
	});

	it("shortcuts.register dispatches with shortcuts.register cap and the additions payload (6.10c)", async () => {
		const { bridge, calls } = fakeBridge([{ ok: true, value: undefined }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		await runtime.services.shortcuts.register({
			additions: [
				{ id: "save", default: "Mod+S", label: "Save" },
				{ id: "find-next", default: "Mod+G", label: "Find Next", scope: "editor" },
			],
		});
		expect(calls[0]).toMatchObject({
			service: "shortcuts",
			method: "register",
			caps: ["shortcuts.register"],
		});
		expect(calls[0]?.args[0]).toEqual({
			additions: [
				{ id: "save", default: "Mod+S", label: "Save" },
				{ id: "find-next", default: "Mod+G", label: "Find Next", scope: "editor" },
			],
		});
	});

	it("shortcuts.unregister dispatches with shortcuts.register cap and the ids payload (6.10c)", async () => {
		const { bridge, calls } = fakeBridge([{ ok: true, value: undefined }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		await runtime.services.shortcuts.unregister({ ids: ["save", "find-next"] });
		expect(calls[0]).toMatchObject({
			service: "shortcuts",
			method: "unregister",
			caps: ["shortcuts.register"],
		});
		expect(calls[0]?.args[0]).toEqual({ ids: ["save", "find-next"] });
	});

	it("shortcuts.setActiveScope round-trips a string scope; null clears (6.10c)", async () => {
		const { bridge, calls } = fakeBridge([
			{ ok: true, value: undefined },
			{ ok: true, value: undefined },
		]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		await runtime.services.shortcuts.setActiveScope({ scope: "editor" });
		expect(calls[0]?.args[0]).toEqual({ scope: "editor" });
		await runtime.services.shortcuts.setActiveScope({ scope: null });
		expect(calls[1]?.args[0]).toEqual({ scope: null });
	});

	it("bp.dispatch forwards {entityId, payload} as a no-cap 'bp.dispatch' envelope", async () => {
		const response = {
			requestId: "r1",
			messageName: "updateEntityResponse",
			module: "graph",
			source: "embedder",
			timestamp: "2026-05-29T00:00:00.000Z",
			data: { ok: true },
		};
		const { bridge, calls } = fakeBridge([{ ok: true, value: response }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		const message = {
			requestId: "r1",
			messageName: "updateEntity",
			module: "graph",
			source: "block",
			timestamp: "2026-05-29T00:00:00.000Z",
			data: { entityId: "ent_1" },
		};
		const result = await runtime.services.bp.dispatch("ent_embed", message);
		expect(calls[0]).toMatchObject({ service: "bp", method: "dispatch", caps: [] });
		expect(calls[0]?.args[0]).toEqual({ entityId: "ent_embed", payload: message });
		expect(result).toEqual(response);
	});

	it("bp.dispatch returns null when the router declines to respond", async () => {
		const { bridge } = fakeBridge([{ ok: true, value: null }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		const result = await runtime.services.bp.dispatch("ent_embed", {
			requestId: "r2",
			messageName: "garbage",
			module: "graph",
			source: "block",
			timestamp: "t",
		});
		expect(result).toBeNull();
	});

	it("a throwing handler does not prevent sibling handlers from running", () => {
		const emitter = new LifecycleEmitter();
		const seen: string[] = [];
		emitter.on("suspend", () => {
			throw new Error("boom");
		});
		emitter.on("suspend", () => {
			seen.push("survived");
		});
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		emitter.emit({ type: "suspend" });
		expect(seen).toEqual(["survived"]);
		spy.mockRestore();
	});
});

// Late import — vi is used by the spy test above.
import { vi } from "vitest";

describe("network.readable proxy (Net-2c)", () => {
	it("declares network.readable and passes the input through", async () => {
		const { bridge, calls } = fakeBridge([{ ok: true, value: { preview: {}, blocks: null } }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		await runtime.services.network.readable({ url: "https://x.test", locale: "en" });
		expect(calls[0]).toMatchObject({
			service: "network",
			method: "readable",
			caps: ["network.readable"],
		});
		expect(calls[0]?.args[0]).toEqual({ url: "https://x.test", locale: "en" });
	});

	it("adds the .private scope-widener when allowPrivate is set", async () => {
		const { bridge, calls } = fakeBridge([{ ok: true, value: { preview: {}, blocks: null } }]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		await runtime.services.network.readable({ url: "https://x.test", allowPrivate: true });
		expect(calls[0]?.caps).toEqual(["network.readable", "network.readable.private"]);
	});
});

describe("locale (12.15)", () => {
	it("defaults to DEFAULT_LOCALE when the handshake omits one", () => {
		const { bridge } = fakeBridge([]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		expect(runtime.locale).toBe("en");
	});

	it("reflects the handshake locale at build time", () => {
		const { bridge } = fakeBridge([]);
		const { runtime } = buildRuntimeWithEmitter({
			handshake: { ...handshake, locale: "es-ES" },
			bridge,
		});
		expect(runtime.locale).toBe("es-ES");
	});

	it("setLocale updates runtime.locale and notifies onLocaleChange listeners", () => {
		const { bridge } = fakeBridge([]);
		const { runtime, setLocale } = buildRuntimeWithEmitter({ handshake, bridge });
		const seen: string[] = [];
		runtime.onLocaleChange((locale) => seen.push(locale));
		setLocale("de-DE");
		expect(runtime.locale).toBe("de-DE");
		expect(seen).toEqual(["de-DE"]);
	});

	it("a no-op setLocale (same / empty / non-string) never notifies", () => {
		const { bridge } = fakeBridge([]);
		const { runtime, setLocale } = buildRuntimeWithEmitter({
			handshake: { ...handshake, locale: "fr" },
			bridge,
		});
		const seen: string[] = [];
		runtime.onLocaleChange((locale) => seen.push(locale));
		setLocale("fr"); // same value
		setLocale(""); // empty
		setLocale(undefined as unknown as string); // non-string
		expect(seen).toEqual([]);
		expect(runtime.locale).toBe("fr");
	});

	it("unsubscribing stops further notifications", () => {
		const { bridge } = fakeBridge([]);
		const { runtime, setLocale } = buildRuntimeWithEmitter({ handshake, bridge });
		const seen: string[] = [];
		const sub = runtime.onLocaleChange((locale) => seen.push(locale));
		setLocale("es");
		sub.unsubscribe();
		setLocale("de");
		expect(seen).toEqual(["es"]);
	});

	it("a throwing listener never breaks sibling listeners", () => {
		const { bridge } = fakeBridge([]);
		const { runtime, setLocale } = buildRuntimeWithEmitter({ handshake, bridge });
		const seen: string[] = [];
		runtime.onLocaleChange(() => {
			throw new Error("boom");
		});
		runtime.onLocaleChange((locale) => seen.push(locale));
		expect(() => setLocale("ja")).not.toThrow();
		expect(seen).toEqual(["ja"]);
	});
});

describe("format context (12.15 15f)", () => {
	it("defaults to an empty context when the handshake omits one", () => {
		const { bridge } = fakeBridge([]);
		const { runtime } = buildRuntimeWithEmitter({ handshake, bridge });
		expect(runtime.format).toEqual({});
	});

	it("reflects the handshake format at build time", () => {
		const { bridge } = fakeBridge([]);
		const { runtime } = buildRuntimeWithEmitter({
			handshake: { ...handshake, format: { locale: "de", hour12: false, timeZone: "Europe/Berlin" } },
			bridge,
		});
		expect(runtime.format).toEqual({ locale: "de", hour12: false, timeZone: "Europe/Berlin" });
	});

	it("setFormat updates runtime.format and notifies onFormatChange listeners", () => {
		const { bridge } = fakeBridge([]);
		const { runtime, setFormat } = buildRuntimeWithEmitter({ handshake, bridge });
		const seen: unknown[] = [];
		runtime.onFormatChange((format) => seen.push(format));
		setFormat({ locale: "es", hour12: true });
		expect(runtime.format).toEqual({ locale: "es", hour12: true });
		expect(seen).toEqual([{ locale: "es", hour12: true }]);
	});

	it("a structurally-equal setFormat never notifies", () => {
		const { bridge } = fakeBridge([]);
		const { runtime, setFormat } = buildRuntimeWithEmitter({
			handshake: { ...handshake, format: { locale: "fr", timeZone: "Europe/Paris" } },
			bridge,
		});
		const seen: unknown[] = [];
		runtime.onFormatChange((format) => seen.push(format));
		setFormat({ locale: "fr", timeZone: "Europe/Paris" });
		expect(seen).toEqual([]);
		expect(runtime.format).toEqual({ locale: "fr", timeZone: "Europe/Paris" });
	});

	it("a throwing format listener never breaks sibling listeners", () => {
		const { bridge } = fakeBridge([]);
		const { runtime, setFormat } = buildRuntimeWithEmitter({ handshake, bridge });
		const seen: unknown[] = [];
		runtime.onFormatChange(() => {
			throw new Error("boom");
		});
		runtime.onFormatChange((format) => seen.push(format));
		expect(() => setFormat({ locale: "ja" })).not.toThrow();
		expect(seen).toEqual([{ locale: "ja" }]);
	});
});

describe("handshake format round-trip (12.15 15f)", () => {
	it("encodeHandshake → decodeHandshake preserves format", () => {
		const encoded = encodeHandshake({
			...handshake,
			format: { locale: "de-AT", hour12: false, timeZone: "Europe/Vienna" },
		});
		expect(decodeHandshake(encoded).format).toEqual({
			locale: "de-AT",
			hour12: false,
			timeZone: "Europe/Vienna",
		});
	});
});

describe("handshake locale round-trip (12.15)", () => {
	it("encodeHandshake → decodeHandshake preserves locale", () => {
		const encoded = encodeHandshake({ ...handshake, locale: "pt-BR" });
		expect(decodeHandshake(encoded).locale).toBe("pt-BR");
	});

	it("a handshake without locale decodes to undefined", () => {
		const encoded = encodeHandshake(handshake);
		expect(decodeHandshake(encoded).locale).toBeUndefined();
	});
});
