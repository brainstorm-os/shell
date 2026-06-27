/**
 * `vault-entities-service` — the read surface. It reads `entities.db`
 * **directly** (no per-app kv scan). These tests pin the shared-store
 * read semantics + the documented edge / dangling-link rules + the
 * fault-isolation invariant ("`list()` must never reject").
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "../../ipc/envelope";
import type { QueryPatternResult } from "../storage/entities-repo";
import { MENTION_NODE_TYPE } from "./extract-note-references";
import type { SharedEntitiesRepo } from "./vault-entities-service";
import {
	NOTE_MENTION_LINK_TYPE,
	NOTE_TYPE,
	listVaultEntities,
	makeVaultEntitiesServiceHandler,
	queryVaultPattern,
} from "./vault-entities-service";

function makeEnvelope(method: string): Envelope {
	return {
		v: 1,
		msg: "m1",
		app: "io.brainstorm.graph",
		service: "vault-entities",
		method,
		args: [],
		caps: ["entities.read:*"],
	};
}

const repoStub = (
	entities: ReadonlyArray<{
		id: string;
		type: string;
		properties: Record<string, unknown>;
		createdBy: string;
		createdAt: number;
		updatedAt: number;
	}>,
	links: Record<
		string,
		ReadonlyArray<{
			id: string;
			sourceEntityId: string;
			destEntityId: string;
			linkType: string;
			createdAt: number;
		}>
	> = {},
) => ({
	query: () => entities,
	linksFrom: (id: string) => links[id] ?? [],
});

describe("vault-entities-service — read surface (9.3.5.R)", () => {
	it("returns an empty snapshot when no entities repo is provided", async () => {
		const snapshot = await listVaultEntities("/some/vault");
		expect(snapshot.entities).toEqual([]);
		expect(snapshot.links).toEqual([]);
	});

	it("returns an empty snapshot when the repo is null", async () => {
		const snapshot = await listVaultEntities("/some/vault", async () => null);
		expect(snapshot.entities).toEqual([]);
		expect(snapshot.links).toEqual([]);
	});

	it("the broker handler routes list() through to the entities store", async () => {
		const handler = makeVaultEntitiesServiceHandler({
			getVaultPath: () => "/vault",
			getEntitiesRepo: async () =>
				repoStub([
					{ id: "e1", type: "x/A/v1", properties: {}, createdBy: "io.x", createdAt: 1, updatedAt: 1 },
				]),
		});
		const result = (await handler(makeEnvelope("list"))) as {
			entities: unknown[];
			links: unknown[];
		};
		expect(result.entities).toHaveLength(1);
		expect(result.links).toHaveLength(0);
	});

	it("rejects unknown methods with an Invalid error", async () => {
		const handler = makeVaultEntitiesServiceHandler({ getVaultPath: () => "/vault" });
		await expect(handler(makeEnvelope("nonsense"))).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("surfaces entities.db entities + links into the snapshot", async () => {
		const repo = repoStub(
			[
				{
					id: "e1",
					type: "x/A/v1",
					properties: { n: 1 },
					createdBy: "io.x",
					createdAt: 1,
					updatedAt: 2,
				},
				{ id: "e2", type: "x/B/v1", properties: {}, createdBy: "io.x", createdAt: 3, updatedAt: 4 },
			],
			{ e1: [{ id: "l1", sourceEntityId: "e1", destEntityId: "e2", linkType: "rel", createdAt: 5 }] },
		);
		const snap = await listVaultEntities("/vault", async () => repo);
		expect(snap.entities.map((e) => e.id).sort()).toEqual(["e1", "e2"]);
		const e1 = snap.entities.find((e) => e.id === "e1");
		expect(e1).toMatchObject({
			type: "x/A/v1",
			properties: { n: 1 },
			ownerAppId: "io.x",
			deletedAt: null,
		});
		expect(snap.links).toEqual([
			{
				id: "l1",
				sourceEntityId: "e1",
				destEntityId: "e2",
				linkType: "rel",
				createdAt: 5,
				deletedAt: null,
			},
		]);
	});

	it("uses linksFromMany when the repo provides it (batched, not N+1)", async () => {
		// Stub that tracks calls to both link methods so we can prove the
		// service prefers the batched surface.
		const fromManyCalls: string[][] = [];
		const perRowCalls: string[] = [];
		const repo: SharedEntitiesRepo = {
			query: () => [
				{ id: "e1", type: "x/A/v1", properties: {}, createdBy: "x", createdAt: 1, updatedAt: 1 },
				{ id: "e2", type: "x/A/v1", properties: {}, createdBy: "x", createdAt: 2, updatedAt: 2 },
				{ id: "e3", type: "x/A/v1", properties: {}, createdBy: "x", createdAt: 3, updatedAt: 3 },
			],
			linksFrom: (id: string) => {
				perRowCalls.push(id);
				return [];
			},
			linksFromMany: (ids: readonly string[]) => {
				fromManyCalls.push([...ids]);
				return [
					{ id: "l12", sourceEntityId: "e1", destEntityId: "e2", linkType: "r", createdAt: 10 },
					{ id: "l23", sourceEntityId: "e2", destEntityId: "e3", linkType: "r", createdAt: 11 },
				];
			},
		};
		const snap = await listVaultEntities("/vault", async () => repo);
		expect(fromManyCalls).toHaveLength(1);
		expect(fromManyCalls[0]?.sort()).toEqual(["e1", "e2", "e3"]);
		expect(perRowCalls).toEqual([]);
		expect(snap.links.map((l) => l.id).sort()).toEqual(["l12", "l23"]);
	});

	it("excludes structural child types (WhiteboardEdge) from the snapshot", async () => {
		const repo = repoStub([
			{
				id: "wb1",
				type: "brainstorm/Whiteboard/v1",
				properties: { name: "Board" },
				createdBy: "io.brainstorm.whiteboard",
				createdAt: 1,
				updatedAt: 2,
			},
			{
				id: "edge1",
				type: "brainstorm/WhiteboardEdge/v1",
				properties: { whiteboardId: "wb1", sourceNodeId: "n1", destNodeId: "n2" },
				createdBy: "io.brainstorm.whiteboard",
				createdAt: 3,
				updatedAt: 4,
			},
		]);
		const snap = await listVaultEntities("/vault", async () => repo);
		expect(snap.entities.map((e) => e.id)).toEqual(["wb1"]);
		expect(snap.entities.some((e) => e.type === "brainstorm/WhiteboardEdge/v1")).toBe(false);
	});

	it("a throwing repo never rejects — it resolves with an empty snapshot", async () => {
		const snap = await listVaultEntities("/vault", async () => {
			throw new Error("db locked");
		});
		expect(snap).toEqual({ entities: [], links: [] });
	});

	it("a repo whose query() throws resolves with an empty snapshot (no reject)", async () => {
		const snap = await listVaultEntities("/vault", async () => ({
			query: () => {
				throw new Error("simulated entities.db query failure");
			},
			linksFrom: () => [],
		}));
		expect(snap).toEqual({ entities: [], links: [] });
	});

	// ── note→note edge parity for shared rows (9.3.5.N-notes.3a) ──────
	const noteBody = (destId: string) => ({
		root: {
			children: [
				{
					type: "paragraph",
					children: [{ type: MENTION_NODE_TYPE, entityId: destId, entityType: NOTE_TYPE }],
				},
			],
		},
	});

	const noteRow = (id: string, body: unknown, updatedAt = 1) => ({
		id,
		type: NOTE_TYPE,
		properties: { title: id, body },
		createdBy: "io.brainstorm.notes",
		createdAt: 1,
		updatedAt,
	});

	it("derives mention edges from a shared Note/v1 row's body", async () => {
		const repo = repoStub([noteRow("src", noteBody("dst"), 7), noteRow("dst", "")]);
		const snap = await listVaultEntities("/vault", async () => repo);
		expect(snap.links).toEqual([
			{
				id: "lnk_src_mention_dst",
				sourceEntityId: "src",
				destEntityId: "dst",
				linkType: NOTE_MENTION_LINK_TYPE,
				createdAt: 7,
				deletedAt: null,
			},
		]);
	});

	it("a mention to a non-existent entity is dropped by the dangling filter", async () => {
		const repo = repoStub([noteRow("src", noteBody("ghost"), 3)]);
		const snap = await listVaultEntities("/vault", async () => repo);
		expect(snap.links).toEqual([]);
	});

	it("collapses a stored link + its body-derived twin (same stable id) to one", async () => {
		const repo = repoStub([noteRow("src", noteBody("dst"), 9), noteRow("dst", "")], {
			src: [
				{
					id: "lnk_src_mention_dst",
					sourceEntityId: "src",
					destEntityId: "dst",
					linkType: NOTE_MENTION_LINK_TYPE,
					createdAt: 9,
				},
			],
		});
		const snap = await listVaultEntities("/vault", async () => repo);
		const edges = snap.links.filter((l) => l.id === "lnk_src_mention_dst");
		expect(edges).toHaveLength(1);
	});

	it("a shared Note row with no references contributes no edges", async () => {
		const repo = repoStub([
			{
				id: "lonely",
				type: NOTE_TYPE,
				properties: { title: "alone", body: "legacy string body" },
				createdBy: "io.brainstorm.notes",
				createdAt: 1,
				updatedAt: 1,
			},
		]);
		const snap = await listVaultEntities("/vault", async () => repo);
		expect(snap.links).toEqual([]);
	});

	// ── shared-property derived edges ──────────────────────────────────
	it("derives a shared-property edge between two bookmarks with the same tag", async () => {
		const repo = repoStub([
			{
				id: "bm1",
				type: "brainstorm/Bookmark/v1",
				properties: { name: "BM1", url: "https://a.example", tags: ["crdt"] },
				createdBy: "io.brainstorm.bookmarks",
				createdAt: 1,
				updatedAt: 1,
			},
			{
				id: "bm2",
				type: "brainstorm/Bookmark/v1",
				properties: { name: "BM2", url: "https://b.example", tags: ["crdt"] },
				createdBy: "io.brainstorm.bookmarks",
				createdAt: 2,
				updatedAt: 2,
			},
		]);
		const snap = await listVaultEntities("/vault", async () => repo);
		const shared = snap.links.filter(
			(l) => l.linkType === "brainstorm/shared-property/Bookmark.tags",
		);
		expect(shared).toHaveLength(1);
		expect([shared[0]?.sourceEntityId, shared[0]?.destEntityId].sort()).toEqual(["bm1", "bm2"]);
	});

	it("derives Folder/contains edges from Folder.members and respects the dangling filter", async () => {
		const repo = repoStub([
			{
				id: "folder-docs",
				type: "brainstorm/Folder/v1",
				properties: { name: "docs", members: ["doc-arch", "doc-ghost"] },
				createdBy: "io.brainstorm.self-hosting",
				createdAt: 1,
				updatedAt: 1,
			},
			{
				id: "doc-arch",
				type: "brainstorm/DesignDoc/v1",
				properties: { title: "Architecture" },
				createdBy: "io.brainstorm.self-hosting",
				createdAt: 1,
				updatedAt: 1,
			},
			// `doc-ghost` is missing from the snapshot — dangling filter
			// must strip that edge but keep the live one.
		]);
		const snap = await listVaultEntities("/vault", async () => repo);
		const contains = snap.links.filter((l) => l.linkType === "brainstorm/Folder/contains");
		expect(contains).toHaveLength(1);
		expect(contains[0]).toMatchObject({
			sourceEntityId: "folder-docs",
			destEntityId: "doc-arch",
		});
	});

	it("derived shared-property edges respect the dangling-link filter", async () => {
		// A bookmark whose pair partner is somehow missing from the
		// snapshot (shouldn't happen — entities are the source — but the
		// filter has to hold). With one bookmark alone, no pair → no edge.
		const repo = repoStub([
			{
				id: "bm1",
				type: "brainstorm/Bookmark/v1",
				properties: { name: "alone", url: "https://x", tags: ["crdt"] },
				createdBy: "io.brainstorm.bookmarks",
				createdAt: 1,
				updatedAt: 1,
			},
		]);
		const snap = await listVaultEntities("/vault", async () => repo);
		expect(snap.links.filter((l) => l.linkType.startsWith("brainstorm/shared-property/"))).toEqual(
			[],
		);
	});
});

describe("vault-entities-service — temp vault lifecycle (smoke)", () => {
	let vaultPath: string;
	beforeEach(async () => {
		vaultPath = await mkdtemp(join(tmpdir(), "vault-entities-"));
	});
	afterEach(async () => {
		await rm(vaultPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	it("no repo + a real vault path → empty snapshot (kv is no longer scanned)", async () => {
		const snap = await listVaultEntities(vaultPath);
		expect(snap.entities).toEqual([]);
		expect(snap.links).toEqual([]);
	});
});

describe("vault-entities-service — queryPattern (9.13.3)", () => {
	const wellFormed = {
		subjects: {
			A: { kind: "entity", types: ["x/Person/v1"], where: null, displayName: "Person" },
		},
		edges: [],
		primarySubject: "A",
	};

	const patternRepo = (result: QueryPatternResult, calls: unknown[] = []) => ({
		query: () => [],
		linksFrom: () => [],
		queryPattern: (p: unknown) => {
			calls.push(p);
			return result;
		},
	});

	it("rejects a structurally-malformed pattern as pattern-invalid (no repo touch)", async () => {
		let touched = false;
		const r = await queryVaultPattern({ nope: true }, async () => {
			touched = true;
			return patternRepo({ ok: true } as unknown as QueryPatternResult);
		});
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.kind).toBe("pattern-invalid");
		expect(touched).toBe(false);
	});

	it("ok-empty when no repo is supplied (renderer stays quiet)", async () => {
		const r = await queryVaultPattern(wellFormed);
		expect(r).toEqual({ ok: true, snapshot: { entities: [], links: [] } });
	});

	it("maps a cost-cap rejection to a pattern-too-expensive error", async () => {
		const repo = patternRepo({
			ok: false,
			cost: { code: "pattern-too-expensive", estimatedRows: 9_000_000, ceiling: 2_000_000 },
		});
		const r = await queryVaultPattern(wellFormed, async () => repo);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.kind).toBe("pattern-too-expensive");
		expect(r.error.message).toContain("9000000");
	});

	it("maps a compile error to a pattern-invalid error", async () => {
		const repo = patternRepo({
			ok: false,
			compile: { ok: false, error: { code: "no-subjects" } },
		} as unknown as QueryPatternResult);
		const r = await queryVaultPattern(wellFormed, async () => repo);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.kind).toBe("pattern-invalid");
		expect(r.error.message).toContain("no-subjects");
	});

	it("projects a matched subgraph into the list()-shape snapshot, dropping dangling links", async () => {
		const repo = patternRepo({
			ok: true,
			estimatedRows: 4,
			result: {
				entities: [
					{
						id: "p1",
						type: "x/Person/v1",
						spaceId: null,
						properties: { name: "Ann" },
						createdBy: "io.x",
						createdAt: 1,
						updatedAt: 2,
					},
					{
						id: "p2",
						type: "x/Person/v1",
						spaceId: null,
						properties: {},
						createdBy: "io.x",
						createdAt: 3,
						updatedAt: 4,
					},
				],
				links: [
					{ id: "l1", sourceEntityId: "p1", destEntityId: "p2", linkType: "knows", createdAt: 5 },
					{
						id: "dangling",
						sourceEntityId: "p1",
						destEntityId: "gone",
						linkType: "knows",
						createdAt: 6,
					},
				],
				matches: [],
			},
		});
		const r = await queryVaultPattern(wellFormed, async () => repo);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.snapshot.entities.map((e) => e.id).sort()).toEqual(["p1", "p2"]);
		expect(r.snapshot.entities[0]).toMatchObject({ ownerAppId: "io.x", deletedAt: null });
		// The dangling link (dest "gone" not in the entity set) is dropped.
		expect(r.snapshot.links.map((l) => l.id)).toEqual(["l1"]);
	});

	it("ok-empty when the repo lacks queryPattern (search-collector stub reuse)", async () => {
		const r = await queryVaultPattern(wellFormed, async () => ({
			query: () => [],
			linksFrom: () => [],
		}));
		expect(r).toEqual({ ok: true, snapshot: { entities: [], links: [] } });
	});

	it("a throwing queryPattern resolves ok-empty (never rejects the renderer)", async () => {
		const r = await queryVaultPattern(wellFormed, async () => ({
			query: () => [],
			linksFrom: () => [],
			queryPattern: () => {
				throw new Error("db locked");
			},
		}));
		expect(r).toEqual({ ok: true, snapshot: { entities: [], links: [] } });
	});

	it("the broker handler routes queryPattern through and returns the envelope result", async () => {
		const repo = patternRepo({
			ok: true,
			estimatedRows: 0,
			result: { entities: [], links: [], matches: [] },
		});
		const handler = makeVaultEntitiesServiceHandler({
			getVaultPath: () => "/vault",
			getEntitiesRepo: async () => repo,
		});
		const result = await handler({
			v: 1,
			msg: "m1",
			app: "io.brainstorm.graph",
			service: "vault-entities",
			method: "queryPattern",
			args: [{ pattern: wellFormed }],
			caps: ["entities.read:*"],
		});
		expect(result).toEqual({ ok: true, snapshot: { entities: [], links: [] } });
	});
});

describe("vault-entities-service — querySource (9.12.3)", () => {
	it("the broker handler routes querySource through; a stub repo without fast paths resolves via the shared evaluator", async () => {
		// No `idsByTypes` on the stub → the resolver falls back to
		// `evaluateSource` over the materialized rows — the same code the
		// Database renderer runs.
		const handler = makeVaultEntitiesServiceHandler({
			getVaultPath: () => "/vault",
			getEntitiesRepo: async () =>
				repoStub([
					{ id: "a1", type: "x/A/v1", properties: {}, createdBy: "io.x", createdAt: 1, updatedAt: 1 },
					{ id: "b1", type: "x/B/v1", properties: {}, createdBy: "io.x", createdAt: 1, updatedAt: 1 },
				]),
		});
		const result = await handler({
			v: 1,
			msg: "m1",
			app: "io.brainstorm.database",
			service: "vault-entities",
			method: "querySource",
			args: [{ source: { kind: "byType", types: ["x/A/v1"] } }],
			caps: ["entities.read:*"],
		});
		expect(result).toEqual({ ok: true, ids: ["a1"] });
	});

	it("a malformed source returns a structured source-invalid error through the handler", async () => {
		const handler = makeVaultEntitiesServiceHandler({
			getVaultPath: () => "/vault",
			getEntitiesRepo: async () => repoStub([]),
		});
		const result = (await handler({
			v: 1,
			msg: "m2",
			app: "io.brainstorm.database",
			service: "vault-entities",
			method: "querySource",
			args: [{ source: { kind: "nope" } }],
			caps: ["entities.read:*"],
		})) as { ok: boolean; error?: { kind: string } };
		expect(result.ok).toBe(false);
		expect(result.error?.kind).toBe("source-invalid");
	});

	it("a missing source arg resolves like a null source (ok, empty)", async () => {
		const handler = makeVaultEntitiesServiceHandler({
			getVaultPath: () => "/vault",
			getEntitiesRepo: async () => repoStub([]),
		});
		const result = await handler(makeEnvelope("querySource"));
		expect(result).toEqual({ ok: true, ids: [] });
	});
});
