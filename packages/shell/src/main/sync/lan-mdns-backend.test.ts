/**
 * The `bonjour-service` adapter, against a stand-in for the library's class.
 *
 * No socket: `vi.mock` replaces the package, so this pins what we ASK the
 * responder for. One test below additionally builds the library's real
 * `Service` (which needs no socket either) to prove the address filter matches
 * the record shapes the installed version actually emits.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type PublishOptions = {
	name: string;
	type: string;
	port: number;
	host?: string;
	disableIPv6?: boolean;
	probe?: boolean;
	txt: Record<string, string>;
};

const fake = vi.hoisted(() => {
	const state = {
		published: [] as {
			opts: PublishOptions;
			stopped: boolean;
			records: (() => { type: string; data?: unknown }[]) | undefined;
			handlers: Map<string, (...args: unknown[]) => void>;
		}[],
		browserHandlers: new Map<string, (...args: unknown[]) => void>(),
		onUp: null as ((service: unknown) => void) | null,
		browserStopped: 0,
		failConstruct: false,
		recordsHook: true,
	};
	class Bonjour {
		constructor() {
			if (state.failConstruct) throw new Error("EADDRINUSE 5353");
		}
		publish(opts: PublishOptions) {
			const service = {
				opts,
				stopped: false,
				handlers: new Map<string, (...args: unknown[]) => void>(),
				records: (() => [
					{ type: "PTR", data: "x" },
					{ type: "SRV", data: { port: opts.port, target: opts.host } },
					{ type: "TXT", data: opts.txt },
					{ type: "A", data: "192.168.1.10" },
					{ type: "A", data: "10.8.0.2" },
					{ type: "A", data: "203.0.113.7" },
					{ type: "AAAA", data: "2001:db8::1" },
					{ type: "AAAA", data: "fe80::1" },
				]) as (() => { type: string; data?: unknown }[]) | undefined,
				stop(callback?: () => void) {
					service.stopped = true;
					callback?.();
				},
				on(event: string, listener: (...args: unknown[]) => void) {
					service.handlers.set(event, listener);
				},
			};
			if (!state.recordsHook) service.records = undefined;
			state.published.push(service);
			return service;
		}
		find(_opts: { type: string }, onUp: (service: unknown) => void) {
			state.onUp = onUp;
			return {
				stop: () => {
					state.browserStopped += 1;
				},
				removeAllListeners: () => state.browserHandlers.clear(),
				on: (event: string, listener: (...args: unknown[]) => void) => {
					state.browserHandlers.set(event, listener);
				},
			};
		}
		destroy(callback?: () => void) {
			callback?.();
		}
	}
	return { state, Bonjour };
});

vi.mock("bonjour-service", () => ({ Bonjour: fake.Bonjour }));

import { createLanMdnsBackend, restrictAddressRecords } from "./lan-mdns-backend";

const NAME = "brainstorm-0011223344556677";
const ADVERT = {
	type: "brainstorm-sync",
	name: NAME,
	port: 51_820,
	addresses: ["192.168.1.10"],
	txt: { v: "2", t: "first" },
};

beforeEach(() => {
	fake.state.published.length = 0;
	fake.state.browserHandlers.clear();
	fake.state.onUp = null;
	fake.state.browserStopped = 0;
	fake.state.failConstruct = false;
	fake.state.recordsHook = true;
});

async function backend() {
	const built = await createLanMdnsBackend();
	if (!built) throw new Error("backend unavailable");
	return built;
}

describe("createLanMdnsBackend — what the advert discloses", () => {
	it("publishes under a per-boot host, never the machine's hostname", async () => {
		await (await backend()).publish(ADVERT);
		const opts = fake.state.published[0]?.opts;
		expect(opts?.host).toBe(`${NAME}.local`);
		expect(opts?.disableIPv6).toBe(true);
	});

	it("never disables the probe, which is what lets the record filter land first", async () => {
		await (await backend()).publish(ADVERT);
		expect(fake.state.published[0]?.opts.probe).toBeUndefined();
	});

	it("keeps address records to the addresses we chose to advertise", async () => {
		await (await backend()).publish(ADVERT);
		const records = fake.state.published[0]?.records?.() ?? [];
		expect(records.filter((r) => r.type === "A").map((r) => r.data)).toEqual(["192.168.1.10"]);
		expect(records.some((r) => r.type === "AAAA")).toBe(false);
		expect(records.map((r) => r.type)).toEqual(["PTR", "SRV", "TXT", "A"]);
	});

	it("filters the records the installed library really builds", async () => {
		const { Service } = (await vi.importActual("bonjour-service")) as {
			Service: new (
				config: PublishOptions,
			) => { host: string; records(): { type: string; name: string; data?: unknown }[] };
		};
		const service = new Service({ ...ADVERT, host: `${NAME}.local`, disableIPv6: true });
		const raw = service.records();
		const kept = restrictAddressRecords(raw, ["192.168.1.10"]);
		expect(raw.some((r) => r.type === "SRV" && r.name.startsWith(NAME))).toBe(true);
		expect(kept.filter((r) => r.type === "A").every((r) => r.data === "192.168.1.10")).toBe(true);
		expect(kept.some((r) => r.type === "AAAA")).toBe(false);
		expect(kept.filter((r) => r.type !== "A").length).toBe(
			raw.filter((r) => r.type !== "A" && r.type !== "AAAA").length,
		);
		const srv = kept.find((r) => r.type === "SRV");
		expect((srv?.data as { target?: string }).target).toBe(`${NAME}.local`);
		expect(kept.filter((r) => r.type === "A").every((r) => r.name === `${NAME}.local`)).toBe(true);
	});
});

describe("createLanMdnsBackend — the address restriction fails closed", () => {
	it("refuses to advertise when the library no longer exposes the records hook", async () => {
		fake.state.recordsHook = false;
		const onError = vi.fn();
		const built = await createLanMdnsBackend({ onError });
		await expect(built?.publish(ADVERT)).rejects.toThrow(/records hook/);
		expect(fake.state.published[0]?.records?.()).toEqual([]);
		// Whatever was started is withdrawn before it can announce.
		expect(fake.state.published.every((service) => service.stopped)).toBe(true);
	});

	it("still browses, which discloses nothing", async () => {
		fake.state.recordsHook = false;
		const built = await createLanMdnsBackend();
		expect(() => built?.browse("brainstorm-sync", () => undefined)).not.toThrow();
		expect(fake.state.onUp).not.toBeNull();
	});

	it("a refused rotation withdraws the advert instead of leaving the old tag up", async () => {
		const onError = vi.fn();
		const built = await createLanMdnsBackend({ onError });
		const publication = await built?.publish(ADVERT);
		fake.state.recordsHook = false;
		await expect(publication?.updateTxt({ v: "2", t: "second" })).rejects.toThrow(/records hook/);
		expect(fake.state.published.every((service) => service.stopped)).toBe(true);
	});
});

describe("createLanMdnsBackend — rotation reaches the wire", () => {
	it("re-announces the SAME name with the new TXT, withdrawing the old record first", async () => {
		const publication = await (await backend()).publish(ADVERT);
		await publication.updateTxt({ v: "2", t: "second" });
		expect(fake.state.published).toHaveLength(2);
		expect(fake.state.published[0]?.stopped).toBe(true);
		expect(fake.state.published[1]?.opts).toMatchObject({
			name: NAME,
			host: `${NAME}.local`,
			port: 51_820,
			txt: { v: "2", t: "second" },
		});
		expect(fake.state.published[1]?.records?.().filter((r) => r.type === "A")).toHaveLength(1);
		await publication.stop();
		expect(fake.state.published[1]?.stopped).toBe(true);
	});
});

describe("createLanMdnsBackend — browsing", () => {
	it("delivers first sightings and TXT refreshes alike", async () => {
		const seen: unknown[] = [];
		const browse = (await backend()).browse("brainstorm-sync", (record) => seen.push(record));
		fake.state.onUp?.({ name: "a" });
		fake.state.browserHandlers.get("txt-update")?.({ name: "a", refreshed: true });
		expect(seen).toEqual([{ name: "a" }, { name: "a", refreshed: true }]);
		browse.stop();
		expect(fake.state.browserStopped).toBe(1);
	});

	it("absorbs a consumer that throws and a responder that errors", async () => {
		const onError = vi.fn();
		const built = await createLanMdnsBackend({ onError });
		built?.browse("brainstorm-sync", () => {
			throw new Error("consumer");
		});
		expect(() => fake.state.onUp?.({})).not.toThrow();
		fake.state.browserHandlers.get("error")?.(new Error("socket"));
		await built?.publish(ADVERT);
		fake.state.published[0]?.handlers.get("error")?.(new Error("probe"));
		expect(onError).toHaveBeenCalledTimes(3);
	});

	it("returns null when the platform will not give us a responder (OQ-P2P-3)", async () => {
		fake.state.failConstruct = true;
		const onError = vi.fn();
		expect(await createLanMdnsBackend({ onError })).toBeNull();
		expect(onError).toHaveBeenCalledOnce();
	});
});
