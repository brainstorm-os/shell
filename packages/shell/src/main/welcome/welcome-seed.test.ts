import {
	BASELINE_NODES,
	SEED_STANDIN_NODES,
	plantSerializedStateIntoDoc,
} from "@brainstorm-os/editor";
import { describe, expect, it, vi } from "vitest";
import { Doc, XmlText, encodeStateAsUpdate } from "yjs";
import { WELCOME_SEED_CREATED_BY, WELCOME_SEED_VERSION, type WelcomeBody } from "./welcome-content";
import { type WelcomeSeedEntitySpec, WelcomeSeedOutcome, seedWelcomeContent } from "./welcome-seed";

const NOW = 1_700_000_000_000;
const PLANT_NODES = [...BASELINE_NODES, ...SEED_STANDIN_NODES];

/** A `plantBody` backed by a real Y.Doc + the real plant path, so the test
 *  proves the bundled bodies are actually plant-compatible with the extracted
 *  stand-in nodes. Returns the doc per entity for assertions. */
function realPlanter() {
	const docs = new Map<string, Doc>();
	const plantBody = (entityId: string, body: WelcomeBody) => {
		const doc = new Doc();
		plantSerializedStateIntoDoc(doc, body as never, {
			nodes: PLANT_NODES,
			namespace: `welcome-${entityId}`,
		});
		docs.set(entityId, doc);
	};
	return { docs, plantBody };
}

describe("seedWelcomeContent", () => {
	it("skips when the vault stamp already covers the bundled version", async () => {
		const createEntity = vi.fn();
		const writeVersion = vi.fn();
		const result = await seedWelcomeContent({
			createEntity,
			plantBody: vi.fn(),
			readVersion: () => WELCOME_SEED_VERSION,
			writeVersion,
			now: NOW,
		});
		expect(result.outcome).toBe(WelcomeSeedOutcome.AlreadySeeded);
		expect(createEntity).not.toHaveBeenCalled();
		expect(writeVersion).not.toHaveBeenCalled();
	});

	it("creates all 8 starter entities, plants 2 note bodies, stamps the version", async () => {
		const specs: WelcomeSeedEntitySpec[] = [];
		const { docs, plantBody } = realPlanter();
		const writeVersion = vi.fn();
		const result = await seedWelcomeContent({
			createEntity: (s) => {
				specs.push(s);
			},
			plantBody,
			readVersion: () => 0,
			writeVersion,
			now: NOW,
		});
		expect(result.outcome).toBe(WelcomeSeedOutcome.Seeded);
		expect(result.created).toBe(8);
		expect(result.planted).toBe(2);
		expect(result.errors).toEqual([]);
		expect(writeVersion).toHaveBeenCalledWith(WELCOME_SEED_VERSION);
		// The two note bodies actually planted into a real Y.Doc.
		expect(docs.size).toBe(2);
		for (const doc of docs.values()) {
			expect(doc.get("root", XmlText).length).toBeGreaterThan(0);
			expect(encodeStateAsUpdate(doc).byteLength).toBeGreaterThan(16);
		}
	});

	it("attributes every entity to the shell seed sentinel + stamps `now`", async () => {
		const specs: WelcomeSeedEntitySpec[] = [];
		await seedWelcomeContent({
			createEntity: (s) => {
				specs.push(s);
			},
			plantBody: vi.fn(),
			readVersion: () => 0,
			writeVersion: vi.fn(),
			now: NOW,
		});
		expect(specs.every((s) => s.createdBy === WELCOME_SEED_CREATED_BY)).toBe(true);
		expect(specs.every((s) => s.now === NOW)).toBe(true);
		expect(specs.every((s) => s.id.startsWith("welcome-"))).toBe(true);
	});

	it("isolates a per-entity create failure and still seeds the rest + stamps", async () => {
		const writeVersion = vi.fn();
		let calls = 0;
		const result = await seedWelcomeContent({
			createEntity: () => {
				calls += 1;
				if (calls === 2) throw new Error("boom");
			},
			plantBody: vi.fn(),
			readVersion: () => 0,
			writeVersion,
			now: NOW,
		});
		expect(result.outcome).toBe(WelcomeSeedOutcome.Seeded);
		expect(result.created).toBe(7);
		expect(result.errors.length).toBe(1);
		expect(result.errors[0]).toContain("boom");
		expect(writeVersion).toHaveBeenCalledWith(WELCOME_SEED_VERSION);
	});

	it("records a stamp-write failure without throwing", async () => {
		const result = await seedWelcomeContent({
			createEntity: vi.fn(),
			plantBody: vi.fn(),
			readVersion: () => 0,
			writeVersion: () => {
				throw new Error("disk full");
			},
			now: NOW,
		});
		expect(result.outcome).toBe(WelcomeSeedOutcome.Seeded);
		expect(result.errors.some((e) => e.startsWith("stamp:"))).toBe(true);
	});

	it("is idempotent end-to-end: a second run after a real seed does nothing", async () => {
		let stamp = 0;
		const createEntity = vi.fn();
		const deps = {
			createEntity,
			plantBody: vi.fn(),
			readVersion: () => stamp,
			writeVersion: (v: number) => {
				stamp = v;
			},
			now: NOW,
		};
		const first = await seedWelcomeContent(deps);
		expect(first.outcome).toBe(WelcomeSeedOutcome.Seeded);
		expect(createEntity).toHaveBeenCalledTimes(8);
		createEntity.mockClear();
		const second = await seedWelcomeContent(deps);
		expect(second.outcome).toBe(WelcomeSeedOutcome.AlreadySeeded);
		expect(createEntity).not.toHaveBeenCalled();
	});
});
