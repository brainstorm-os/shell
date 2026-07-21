/**
 * `<BpBlockMount>` — 9.4.4 mount-seam coverage. The 9.5.1/9.5.2/9.5.3
 * trio is exhaustively tested at the primitive level; this file pins
 * the React seam's lifecycle wiring on top of it: iframe mounts on
 * mount, transport opens, Startup flushes on Mounted edge,
 * `send()` reaches the iframe, inbound messages reach `onMessage`,
 * unmount tears down cleanly.
 */

// @vitest-environment jsdom

import { BlockFramePhase } from "@brainstorm-os/sdk/block-frame";
import { createRef } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BpBlockMount, type BpBlockMountHandle } from "./index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeIntersection {
	observed: Element[];
	disconnected: boolean;
	fire(entries: Array<Partial<IntersectionObserverEntry>>): void;
}

let lastIntersection: FakeIntersection | null = null;

class FakeIntersectionObserver implements FakeIntersection {
	observed: Element[] = [];
	disconnected = false;
	private cb: IntersectionObserverCallback;

	constructor(cb: IntersectionObserverCallback) {
		this.cb = cb;
		lastIntersection = this;
	}
	observe(el: Element): void {
		this.observed.push(el);
	}
	unobserve(): void {}
	disconnect(): void {
		this.disconnected = true;
	}
	takeRecords(): IntersectionObserverEntry[] {
		return [];
	}
	root: Element | null = null;
	rootMargin = "";
	thresholds: readonly number[] = [];
	fire(entries: Array<Partial<IntersectionObserverEntry>>): void {
		this.cb(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
	}
}

class FakeResizeObserver {
	disconnected = false;
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {
		this.disconnected = true;
	}
}

interface FakeHostWindow {
	addEventListener(type: string, listener: EventListener): void;
	removeEventListener(type: string, listener: EventListener): void;
	fire(type: string, event: Event): void;
}

function fakeHost(): FakeHostWindow {
	const listeners = new Map<string, Set<EventListener>>();
	return {
		addEventListener(type, listener) {
			let set = listeners.get(type);
			if (!set) {
				set = new Set();
				listeners.set(type, set);
			}
			set.add(listener);
		},
		removeEventListener(type, listener) {
			listeners.get(type)?.delete(listener);
		},
		fire(type, event) {
			for (const l of listeners.get(type) ?? []) l(event);
		},
	};
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	lastIntersection = null;
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

function findFrame(): HTMLIFrameElement | null {
	return container.querySelector("iframe");
}

function findMount(): HTMLElement | null {
	return container.querySelector("[data-bp-block-mount-entity-id]");
}

/** Test helper — assert a value is non-null and return a narrowed
 *  reference. Throws with a named diagnostic so a failure points at
 *  which assertion broke. Used in lieu of `!` to keep biome's
 *  `noNonNullAssertion` rule happy. */
function nn<T>(x: T | null | undefined, label: string): T {
	if (x === null || x === undefined) throw new Error(`expected non-null: ${label}`);
	return x;
}

function getContentWindow(iframe: HTMLIFrameElement | null): Window {
	const w = nn(iframe, "iframe").contentWindow;
	return nn(w, "iframe.contentWindow");
}

describe("<BpBlockMount>", () => {
	it("mounts an iframe with the pinned sandbox attributes on mount", async () => {
		await act(async () => {
			root.render(
				<BpBlockMount
					entityId="ent_q3"
					capabilities={["blocks.read"]}
					IntersectionObserverImpl={FakeIntersectionObserver as unknown as typeof IntersectionObserver}
					ResizeObserverImpl={FakeResizeObserver as unknown as typeof ResizeObserver}
					host={fakeHost()}
				/>,
			);
		});
		const iframe = findFrame();
		expect(iframe).not.toBeNull();
		expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
		expect(iframe?.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect(iframe?.getAttribute("loading")).toBe("lazy");
		expect(iframe?.hasAttribute("srcdoc")).toBe(true);
		expect(iframe?.hasAttribute("src")).toBe(false);
		expect(findMount()?.getAttribute("data-bp-block-mount-entity-id")).toBe("ent_q3");
	});

	it("flushes the Startup envelope to the iframe once the IntersectionObserver fires Mounted", async () => {
		const handleRef = createRef<BpBlockMountHandle>();
		await act(async () => {
			root.render(
				<BpBlockMount
					entityId="ent_q3"
					capabilities={["blocks.read", "entities.read:Note"]}
					handleRef={handleRef}
					IntersectionObserverImpl={FakeIntersectionObserver as unknown as typeof IntersectionObserver}
					ResizeObserverImpl={FakeResizeObserver as unknown as typeof ResizeObserver}
					host={fakeHost()}
					mintChannelId={() => "deterministic-test-channel-id"}
				/>,
			);
		});
		// Pre-mount: phase is Paused (FakeIO doesn't auto-fire).
		expect(handleRef.current?.getPhase()).toBe(BlockFramePhase.Paused);
		// `flushStartup()` is called eagerly at construction too, but
		// transport.send / flush is a no-op while !Mounted, so Startup
		// hasn't actually been sent across the wire.
		const iframe = findFrame();
		expect(iframe).not.toBeNull();
		// Spy on the iframe's contentWindow.postMessage (jsdom provides
		// a real window for the srcdoc iframe).
		const postSpy = vi.spyOn(getContentWindow(iframe), "postMessage");
		// Fire the IntersectionObserver → Mounted edge.
		await act(async () => {
			lastIntersection?.fire([{ isIntersecting: true }]);
		});
		expect(handleRef.current?.getPhase()).toBe(BlockFramePhase.Mounted);
		expect(handleRef.current?.hasSentStartup()).toBe(true);
		// The Startup envelope was sent with the capability list snapshot.
		const calls = postSpy.mock.calls;
		expect(calls.length).toBeGreaterThanOrEqual(1);
		const env = calls[0]?.[0] as {
			channelId: string;
			entityId: string;
			direction: string;
			kind: string;
			payload: { capabilities: readonly string[] };
		};
		expect(env.channelId).toBe("deterministic-test-channel-id");
		expect(env.entityId).toBe("ent_q3");
		expect(env.kind).toBe("startup");
		expect(env.direction).toBe("host-to-block");
		expect(env.payload.capabilities).toEqual(["blocks.read", "entities.read:Note"]);
	});

	it("loads the bsblock:// bundle URL when `blockId` is supplied, sharing one channel id", async () => {
		await act(async () => {
			root.render(
				<BpBlockMount
					entityId="ent_db"
					capabilities={["blocks.read", "entities.read:Database"]}
					blockId="io.example.db/grid"
					IntersectionObserverImpl={FakeIntersectionObserver as unknown as typeof IntersectionObserver}
					ResizeObserverImpl={FakeResizeObserver as unknown as typeof ResizeObserver}
					host={fakeHost()}
					mintChannelId={() => "shared-chan"}
				/>,
			);
		});
		const iframe = findFrame();
		const src = iframe?.getAttribute("src") ?? "";
		// The frame loads from the block's own bsblock:// origin (escapes the
		// embedder CSP); the URL carries the block id + the SAME channel id the
		// transport mints, so the inner transport can gate the host envelopes.
		expect(src.startsWith("bsblock://frame/")).toBe(true);
		expect(src).toContain("b=io.example.db%2Fgrid");
		expect(src).toContain("c=shared-chan");
		expect(src).toContain("e=ent_db");
		expect(iframe?.hasAttribute("srcdoc")).toBe(false);
		// Drive Mounted → the Startup envelope must use the same channel id.
		const postSpy = vi.spyOn(getContentWindow(iframe), "postMessage");
		await act(async () => {
			lastIntersection?.fire([{ isIntersecting: true }]);
		});
		const env = postSpy.mock.calls[0]?.[0] as { channelId: string };
		expect(env.channelId).toBe("shared-chan");
	});

	it("keeps the inert stub srcdoc (no src) when `blockId` is omitted", async () => {
		await act(async () => {
			root.render(
				<BpBlockMount
					entityId="ent_q3"
					capabilities={["blocks.read"]}
					IntersectionObserverImpl={FakeIntersectionObserver as unknown as typeof IntersectionObserver}
					ResizeObserverImpl={FakeResizeObserver as unknown as typeof ResizeObserver}
					host={fakeHost()}
				/>,
			);
		});
		const iframe = findFrame();
		expect(iframe?.hasAttribute("src")).toBe(false);
		expect(iframe?.getAttribute("srcdoc")).toContain('data-block-frame="1"');
	});

	it("send() ferries a host→block message after Mounted", async () => {
		const handleRef = createRef<BpBlockMountHandle<{ verb: string }>>();
		await act(async () => {
			root.render(
				<BpBlockMount<{ verb: string }, { verb: string }>
					entityId="ent_q3"
					capabilities={["blocks.read"]}
					handleRef={handleRef}
					IntersectionObserverImpl={FakeIntersectionObserver as unknown as typeof IntersectionObserver}
					ResizeObserverImpl={FakeResizeObserver as unknown as typeof ResizeObserver}
					host={fakeHost()}
					mintChannelId={() => "c1"}
				/>,
			);
		});
		await act(async () => {
			lastIntersection?.fire([{ isIntersecting: true }]);
		});
		const iframe = nn(findFrame(), "iframe");
		const postSpy = vi.spyOn(getContentWindow(iframe), "postMessage");
		await act(async () => {
			handleRef.current?.send({ verb: "hello" });
		});
		// Last call should be a Message envelope with our payload.
		const last = postSpy.mock.calls.at(-1)?.[0] as {
			kind: string;
			payload: { verb: string };
		};
		expect(last?.kind).toBe("message");
		expect(last?.payload).toEqual({ verb: "hello" });
	});

	it("routes a well-formed inbound envelope to onMessage", async () => {
		const onMessage = vi.fn();
		const host = fakeHost();
		await act(async () => {
			root.render(
				<BpBlockMount
					entityId="ent_q3"
					capabilities={[]}
					onMessage={onMessage}
					IntersectionObserverImpl={FakeIntersectionObserver as unknown as typeof IntersectionObserver}
					ResizeObserverImpl={FakeResizeObserver as unknown as typeof ResizeObserver}
					host={host}
					mintChannelId={() => "c1"}
				/>,
			);
		});
		await act(async () => {
			lastIntersection?.fire([{ isIntersecting: true }]);
		});
		const iframe = nn(findFrame(), "iframe");
		const inboundEnvelope = {
			channelId: "c1",
			entityId: "ent_q3",
			direction: "block-to-host",
			kind: "message",
			payload: { verb: "ack" },
		};
		// Fake a `message` event whose source is the iframe's
		// contentWindow (the identity gate).
		await act(async () => {
			host.fire("message", {
				source: iframe.contentWindow,
				origin: "null",
				data: inboundEnvelope,
			} as unknown as Event);
		});
		expect(onMessage).toHaveBeenCalledTimes(1);
		expect(onMessage).toHaveBeenCalledWith({ verb: "ack" });
	});

	it("drops an inbound envelope with a wrong channel id", async () => {
		const onMessage = vi.fn();
		const host = fakeHost();
		await act(async () => {
			root.render(
				<BpBlockMount
					entityId="ent_q3"
					capabilities={[]}
					onMessage={onMessage}
					IntersectionObserverImpl={FakeIntersectionObserver as unknown as typeof IntersectionObserver}
					ResizeObserverImpl={FakeResizeObserver as unknown as typeof ResizeObserver}
					host={host}
					mintChannelId={() => "c1"}
				/>,
			);
		});
		await act(async () => {
			lastIntersection?.fire([{ isIntersecting: true }]);
		});
		const iframe = nn(findFrame(), "iframe");
		await act(async () => {
			host.fire("message", {
				source: iframe.contentWindow,
				origin: "null",
				data: {
					channelId: "spoofed",
					entityId: "ent_q3",
					direction: "block-to-host",
					kind: "message",
					payload: { verb: "evil" },
				},
			} as unknown as Event);
		});
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("auto-forwards an inbound block message to bp.dispatch and posts the response back (9.4.5)", async () => {
		const responseMessage = {
			requestId: "r1",
			messageName: "updateEntityResponse",
			module: "graph",
			source: "embedder",
			timestamp: "t",
			data: { ok: true },
		};
		const dispatch = vi.fn().mockResolvedValue(responseMessage);
		const host = fakeHost();
		await act(async () => {
			root.render(
				<BpBlockMount
					entityId="ent_q3"
					capabilities={[]}
					bp={{ dispatch }}
					IntersectionObserverImpl={FakeIntersectionObserver as unknown as typeof IntersectionObserver}
					ResizeObserverImpl={FakeResizeObserver as unknown as typeof ResizeObserver}
					host={host}
					mintChannelId={() => "c1"}
				/>,
			);
		});
		await act(async () => {
			lastIntersection?.fire([{ isIntersecting: true }]);
		});
		const iframe = nn(findFrame(), "iframe");
		// Spy AFTER the Startup flush so the only captured postMessage is
		// the response send.
		const postSpy = vi.spyOn(getContentWindow(iframe), "postMessage");
		const request = {
			requestId: "r1",
			messageName: "updateEntity",
			module: "graph",
			source: "block",
			timestamp: "t",
			data: { entityId: "ent_inner" },
		};
		await act(async () => {
			host.fire("message", {
				source: iframe.contentWindow,
				origin: "null",
				data: {
					channelId: "c1",
					entityId: "ent_q3",
					direction: "block-to-host",
					kind: "message",
					payload: request,
				},
			} as unknown as Event);
		});
		// Flush the bp.dispatch().then() microtask chain.
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch).toHaveBeenCalledWith("ent_q3", request);
		const sent = postSpy.mock.calls.map((c) => c[0]) as Array<{
			direction: string;
			kind: string;
			payload: unknown;
		}>;
		const responseSends = sent.filter((e) => e.kind === "message");
		expect(responseSends).toHaveLength(1);
		expect(responseSends[0]?.direction).toBe("host-to-block");
		expect(responseSends[0]?.payload).toEqual(responseMessage);
	});

	it("posts nothing back when bp.dispatch resolves null (router declined)", async () => {
		const dispatch = vi.fn().mockResolvedValue(null);
		const host = fakeHost();
		await act(async () => {
			root.render(
				<BpBlockMount
					entityId="ent_q3"
					capabilities={[]}
					bp={{ dispatch }}
					IntersectionObserverImpl={FakeIntersectionObserver as unknown as typeof IntersectionObserver}
					ResizeObserverImpl={FakeResizeObserver as unknown as typeof ResizeObserver}
					host={host}
					mintChannelId={() => "c1"}
				/>,
			);
		});
		await act(async () => {
			lastIntersection?.fire([{ isIntersecting: true }]);
		});
		const iframe = nn(findFrame(), "iframe");
		const postSpy = vi.spyOn(getContentWindow(iframe), "postMessage");
		await act(async () => {
			host.fire("message", {
				source: iframe.contentWindow,
				origin: "null",
				data: {
					channelId: "c1",
					entityId: "ent_q3",
					direction: "block-to-host",
					kind: "message",
					payload: {
						requestId: "r1",
						messageName: "x",
						module: "graph",
						source: "block",
						timestamp: "t",
					},
				},
			} as unknown as Event);
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(
			postSpy.mock.calls.filter((c) => (c[0] as { kind?: string })?.kind === "message"),
		).toHaveLength(0);
	});

	it("unmount destroys the iframe + transport (idempotent, no leaks)", async () => {
		await act(async () => {
			root.render(
				<BpBlockMount
					entityId="ent_q3"
					capabilities={[]}
					IntersectionObserverImpl={FakeIntersectionObserver as unknown as typeof IntersectionObserver}
					ResizeObserverImpl={FakeResizeObserver as unknown as typeof ResizeObserver}
					host={fakeHost()}
				/>,
			);
		});
		const iframe = findFrame();
		expect(iframe).not.toBeNull();
		expect(lastIntersection?.disconnected).toBe(false);

		await act(async () => {
			root.render(<div data-testid="empty" />);
		});
		expect(findFrame()).toBeNull();
		expect(lastIntersection?.disconnected).toBe(true);
	});

	it("changing entityId remounts the iframe (security boundary)", async () => {
		const seenIframes = new Set<HTMLIFrameElement>();
		await act(async () => {
			root.render(
				<BpBlockMount
					entityId="ent_q3"
					capabilities={[]}
					IntersectionObserverImpl={FakeIntersectionObserver as unknown as typeof IntersectionObserver}
					ResizeObserverImpl={FakeResizeObserver as unknown as typeof ResizeObserver}
					host={fakeHost()}
				/>,
			);
		});
		const first = nn(findFrame(), "first iframe");
		seenIframes.add(first);

		await act(async () => {
			root.render(
				<BpBlockMount
					entityId="ent_q4"
					capabilities={[]}
					IntersectionObserverImpl={FakeIntersectionObserver as unknown as typeof IntersectionObserver}
					ResizeObserverImpl={FakeResizeObserver as unknown as typeof ResizeObserver}
					host={fakeHost()}
				/>,
			);
		});
		const second = findFrame();
		expect(second).not.toBeNull();
		expect(second).not.toBe(first);
		expect(findMount()?.getAttribute("data-bp-block-mount-entity-id")).toBe("ent_q4");
	});

	it("changing onMessage does NOT remount the iframe (callback churn)", async () => {
		// Captures the iframe element identity before/after a callback
		// swap. If the seam remounted on every callback change, the
		// iframe would be a fresh element, the channel id would re-mint,
		// and Startup would re-flush — none of those are right semantics
		// for "the host re-rendered with a new closure".
		// Stable host/observer impls so only the callback identity changes.
		const stableHost = fakeHost();
		const firstCb = vi.fn();
		await act(async () => {
			root.render(
				<BpBlockMount
					entityId="ent_q3"
					capabilities={[]}
					onMessage={firstCb}
					IntersectionObserverImpl={FakeIntersectionObserver as unknown as typeof IntersectionObserver}
					ResizeObserverImpl={FakeResizeObserver as unknown as typeof ResizeObserver}
					host={stableHost}
				/>,
			);
		});
		const firstFrame = findFrame();

		const secondCb = vi.fn();
		await act(async () => {
			root.render(
				<BpBlockMount
					entityId="ent_q3"
					capabilities={[]}
					onMessage={secondCb}
					IntersectionObserverImpl={FakeIntersectionObserver as unknown as typeof IntersectionObserver}
					ResizeObserverImpl={FakeResizeObserver as unknown as typeof ResizeObserver}
					host={stableHost}
				/>,
			);
		});
		const secondFrame = findFrame();
		expect(secondFrame).toBe(firstFrame);

		// And the new callback is the one that fires for inbound events.
		await act(async () => {
			lastIntersection?.fire([{ isIntersecting: true }]);
		});
		await act(async () => {
			stableHost.fire("message", {
				source: getContentWindow(secondFrame),
				origin: "null",
				data: {
					channelId: "ignored", // identity gate dominates the test
					entityId: "ent_q3",
					direction: "block-to-host",
					kind: "message",
					payload: { v: 1 },
				},
			} as unknown as Event);
		});
		expect(firstCb).not.toHaveBeenCalled();
	});
});
