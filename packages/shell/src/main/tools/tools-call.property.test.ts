/**
 * `tools.call` — the envelope property for the first live declaration
 * (Tool-10): whatever a caller puts in `args`, the provider is reached ONLY
 * with a fresh bag holding exactly one key, `source`, naming an unlocked
 * object whose stored type the declaration allows. Everything else is refused
 * before dispatch, by name.
 *
 * The example-based cases in `tools-call.test.ts` pin each gate; this pins
 * that there is no shape of argument bag that slips between them.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import {
	AppToolEffect,
	type AppToolRecord,
	AppToolSurface,
	ValueType,
	appToolId,
} from "@brainstorm-os/sdk-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENVELOPE_PROTOCOL_VERSION, type Envelope } from "../../ipc/envelope";
import { DataStores } from "../storage/data-stores";
import { AppToolsRepository } from "../storage/registry-repo/app-tools-repo";
import { makeToolEntityResolvers } from "./tool-entity-resolvers";
import { TOOLS_PROVIDE_CAPABILITY, toolsCallCapability } from "./tools-call";
import { makeToolsServiceHandler } from "./tools-service";

const CALLER = "io.brainstorm.notes";
const PROVIDER = "io.brainstorm.tasks";
const NOTE_TYPE = "io.brainstorm.notes/Note/v1";
const TOOL = appToolId(PROVIDER, "create-task");

const STORE: Readonly<Record<string, { type: string; properties: Record<string, unknown> }>> = {
	n1: { type: NOTE_TYPE, properties: { title: "A" } },
	n2: { type: NOTE_TYPE, properties: { title: "B" } },
	"n-locked": { type: NOTE_TYPE, properties: { title: "C", locked: true } },
	t1: { type: "brainstorm/Task/v1", properties: { name: "D" } },
};
const CALLABLE = new Set(["n1", "n2"]);

const declaration: AppToolRecord = {
	id: TOOL,
	appId: PROVIDER,
	name: "create-task",
	title: "Create task",
	description: "Add a task named after this note.",
	effect: AppToolEffect.WritesVault,
	appliesTo: [NOTE_TYPE],
	surfaces: [AppToolSurface.Menu],
	input: [
		{
			name: "source",
			description: "The note.",
			required: true,
			valueType: ValueType.EntityRef,
			allowedTypes: [NOTE_TYPE],
		},
	],
	registeredAt: 1,
};

const GRANTS: ReadonlyArray<[string, string]> = [
	[CALLER, toolsCallCapability(PROVIDER, "create-task")],
	[CALLER, `entities.read:${NOTE_TYPE}`],
	[PROVIDER, TOOLS_PROVIDE_CAPABILITY],
	[PROVIDER, "entities.write:brainstorm/Task/v1"],
];
const ledger = {
	has: (app: string, cap: string) => GRANTS.some(([a, c]) => a === app && c === cap),
	listActive: (app: string) =>
		GRANTS.filter(([a]) => a === app).map(([, cap]) => {
			const colon = cap.indexOf(":");
			return {
				capability: colon < 0 ? cap : cap.slice(0, colon),
				scope: colon < 0 ? null : cap.slice(colon + 1),
			};
		}),
} as unknown as CapabilityLedger;

const REFUSALS = new Set(["Invalid", "Denied"]);

describe("tools.call envelope property (Tool-10)", () => {
	let dir: string;
	let stores: DataStores;
	let repo: AppToolsRepository;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "brainstorm-tools-prop-"));
		stores = new DataStores(dir);
		repo = new AppToolsRepository(await stores.open("registry"));
		repo.insertMany([declaration]);
	});
	afterAll(async () => {
		stores.close();
		await rm(dir, { recursive: true, force: true });
	});

	// No fast-check in this repo (see `ipc/envelope.test.ts`): a small seeded
	// generator, so a failure names a case that reproduces.
	function generator(seed: number) {
		let state = seed >>> 0;
		const next = (): number => {
			state = (state + 0x6d2b79f5) >>> 0;
			let t = state;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
		const IDS = [...Object.keys(STORE), "missing", "", "__proto__", "constructor", "N1", " n1"];
		const KEYS = ["source", "Source", "title", "confirmed", "toString", "__proto__", "x"];
		const text = (): string =>
			Array.from({ length: Math.floor(next() * 6) }, () => pick([..."n12t-_ \u202e\u0000é"])).join("");
		const id = (): string => (next() < 0.8 ? pick(IDS) : text());
		const value = (): unknown => {
			const roll = next();
			if (roll < 0.55) return id();
			if (roll < 0.7) return Array.from({ length: Math.floor(next() * 3) }, id);
			if (roll < 0.8) return Math.floor(next() * 10);
			if (roll < 0.87) return next() < 0.5;
			if (roll < 0.94) return null;
			return { id: id() };
		};
		const args = (): Record<string, unknown> => {
			// Half the cases are the well-formed shape, so the accept branch is
			// exercised as hard as the refuse branch.
			if (next() < 0.5) return { source: next() < 0.8 ? pick(Object.keys(STORE)) : value() };
			const bag: Record<string, unknown> = {};
			const count = Math.floor(next() * 4);
			for (let i = 0; i < count; i += 1) {
				Object.defineProperty(bag, pick(KEYS), {
					value: value(),
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
			return bag;
		};
		return { args };
	}

	it("only ever dispatches { source: <an unlocked note> } — and nothing else rides along", async () => {
		const gen = generator(0x70011);
		let accepted = 0;
		let refused = 0;
		for (let run = 0; run < 500; run += 1) {
			const args = gen.args();
			const label = `case ${run}: ${JSON.stringify(args)}`;
			const dispatched: unknown[] = [];
			const handler = makeToolsServiceHandler({
				getRepo: () => repo,
				getLedger: async () => ledger,
				getCallHost: () =>
					({
						call: async (_appId: string, _tool: string, forwarded: unknown) => {
							dispatched.push(forwarded);
							return { ok: true, value: "made" };
						},
						attachedApps: () => new Set([PROVIDER]),
					}) as never,
				getApprovalHost: () => ({ request: async () => true }) as never,
				...makeToolEntityResolvers(async () => ({
					get: (id) => (Object.hasOwn(STORE, id) ? STORE[id] : null),
				})),
			});
			const envelope: Envelope = {
				v: ENVELOPE_PROTOCOL_VERSION,
				msg: "p",
				app: CALLER,
				service: "tools",
				method: "call",
				args: [{ tool: TOOL, args }],
				caps: [],
			};
			const outcome = await handler(envelope).then(
				() => "ok",
				(error: Error) => error.name,
			);

			const source = Object.hasOwn(args, "source") ? args.source : undefined;
			const shouldRun =
				Object.keys(args).length === 1 && typeof source === "string" && CALLABLE.has(source);

			if (shouldRun) {
				accepted += 1;
				expect(outcome, label).toBe("ok");
				expect(dispatched, label).toHaveLength(1);
				const forwarded = dispatched[0] as Record<string, unknown>;
				// A fresh bag, not the caller's object, with the one declared key.
				expect(forwarded, label).not.toBe(args);
				expect(Object.getPrototypeOf(forwarded), label).toBeNull();
				expect(Object.keys(forwarded), label).toEqual(["source"]);
				expect(forwarded.source, label).toBe(source);
			} else {
				refused += 1;
				expect(REFUSALS.has(outcome), `${label} → ${outcome}`).toBe(true);
				expect(dispatched, label).toEqual([]);
			}
		}
		// Both branches really ran — a generator that only ever refuses would
		// pass the loop above and prove nothing.
		expect(accepted).toBeGreaterThan(50);
		expect(refused).toBeGreaterThan(50);
	});
});
