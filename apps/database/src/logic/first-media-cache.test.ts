import { BodyMediaKind } from "@brainstorm-os/react-yjs";
import { describe, expect, it, vi } from "vitest";
import { createFirstMediaCache } from "./first-media-cache";

const decode = (b64: string) =>
	b64.startsWith("img:")
		? { kind: BodyMediaKind.Image, url: b64.slice(4) }
		: b64.startsWith("vid:")
			? { kind: BodyMediaKind.Video, url: b64.slice(4) }
			: null;

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("first-media cache (9.12.31)", () => {
	it("loads once per entity+version, releases the doc, and notifies", async () => {
		const transport = {
			loadDoc: vi.fn(async (id: string) => ({
				snapshotB64: id === "v" ? "vid:brainstorm://f/v.mp4" : "img:brainstorm://f/a.png",
			})),
			closeDoc: vi.fn(async () => {}),
		};
		const cache = createFirstMediaCache(transport, decode);
		const listener = vi.fn();
		cache.subscribe(listener);
		expect(cache.read("e1", 1)).toBeUndefined();
		expect(cache.read("e1", 1)).toBeUndefined();
		await flush();
		await flush();
		expect(cache.read("e1", 1)).toBe("brainstorm://f/a.png");
		expect(transport.loadDoc).toHaveBeenCalledTimes(1);
		expect(transport.closeDoc).toHaveBeenCalledWith("e1");
		expect(listener).toHaveBeenCalled();
		expect(cache.read("e1", 2)).toBeUndefined();
		cache.read("v", 0);
		await flush();
		await flush();
		expect(cache.read("v", 0)).toBeNull();
	});

	it("caps concurrent loads and answers null without a transport or on failure", async () => {
		let resolveAll: () => void = () => {};
		const gate = new Promise<void>((r) => {
			resolveAll = r;
		});
		const transport = {
			loadDoc: vi.fn(async () => {
				await gate;
				throw new Error("nope");
			}),
			closeDoc: vi.fn(async () => {}),
		};
		const cache = createFirstMediaCache(transport, decode);
		for (let i = 0; i < 6; i++) cache.read(`e${i}`, 0);
		expect(transport.loadDoc).toHaveBeenCalledTimes(3);
		resolveAll();
		for (let i = 0; i < 6; i++) await flush();
		expect(transport.loadDoc).toHaveBeenCalledTimes(6);
		expect(cache.read("e0", 0)).toBeNull();
		expect(createFirstMediaCache(null).read("x", 0)).toBeNull();
	});
});
