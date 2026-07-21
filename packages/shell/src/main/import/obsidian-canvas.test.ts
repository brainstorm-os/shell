/**
 * IE-5 `.canvas` → Whiteboard importer. The pure `parseObsidianCanvas` is tested
 * directly; the `importObsidianCanvas` vault binding runs against a real session.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let USER_DATA_DIR = "";
vi.mock("electron", () => ({ app: { getPath: () => USER_DATA_DIR } }));

import { __setSqlcipherDriverForTests } from "@brainstorm-os/sqlite";
import { __resetAtRestProbeForTests } from "@brainstorm-os/sqlite/at-rest-mode";
import { EntitiesRepository } from "../storage/entities-repo";
import { closeActiveVaultSession, getActiveVaultSession } from "../vault/session";
import { createVault } from "../vault/vault";
import {
	WHITEBOARD_EDGE_TYPE,
	WHITEBOARD_TYPE,
	importObsidianCanvas,
	parseObsidianCanvas,
} from "./obsidian-canvas";

const CANVAS = {
	nodes: [
		{ id: "a", type: "text", text: "Idea A", x: 0, y: 0, width: 200, height: 80 },
		{ id: "b", type: "text", text: "Idea B", x: 300, y: 0 },
		{ id: "g", type: "group", label: "Cluster", x: -20, y: -20, width: 600, height: 200 },
		{ id: "f", type: "file", file: "notes/Spec.md", x: 0, y: 200 },
		{ id: "broken" }, // no geometry → defaults; still valid
	],
	edges: [
		{ id: "e1", fromNode: "a", toNode: "b", fromSide: "right", toSide: "left", label: "leads to" },
		{ id: "e2", fromNode: "a", toNode: "ghost" }, // dangling endpoint → dropped
	],
};

describe("parseObsidianCanvas (pure)", () => {
	it("maps nodes (text/group/file) with geometry and defaults", () => {
		const plan = parseObsidianCanvas(CANVAS);
		expect(plan.nodes.map((n) => n.id)).toEqual(["a", "b", "g", "f", "broken"]);
		const a = plan.nodes.find((n) => n.id === "a");
		expect(a).toMatchObject({ kind: "text", text: "Idea A", x: 0, y: 0, width: 200, height: 80 });
		const g = plan.nodes.find((n) => n.id === "g");
		expect(g).toMatchObject({ kind: "group", text: "Cluster" });
		const f = plan.nodes.find((n) => n.id === "f");
		expect(f).toMatchObject({ kind: "text", text: "notes/Spec.md" });
		const broken = plan.nodes.find((n) => n.id === "broken");
		expect(broken).toMatchObject({ kind: "text", width: 250, height: 60 }); // defaults
	});

	it("keeps only edges whose endpoints are real nodes, mapping sides to handles", () => {
		const plan = parseObsidianCanvas(CANVAS);
		expect(plan.edges).toEqual([
			{
				id: "e1",
				sourceNodeId: "a",
				sourceHandle: "right",
				destNodeId: "b",
				destHandle: "left",
				label: "leads to",
			},
		]);
	});

	it("returns empty plans for non-object / empty input", () => {
		expect(parseObsidianCanvas(null)).toEqual({ nodes: [], edges: [] });
		expect(parseObsidianCanvas({})).toEqual({ nodes: [], edges: [] });
	});
});

describe("importObsidianCanvas (vault binding)", () => {
	let workDir = "";

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "bs-canvas-"));
		USER_DATA_DIR = workDir;
		__setSqlcipherDriverForTests(null);
		__resetAtRestProbeForTests();
		await createVault({
			name: "CV",
			path: join(workDir, "vault"),
			keystore: { forceInsecure: true },
			seedStarterContent: false,
		});
	});

	afterEach(async () => {
		closeActiveVaultSession();
		await rm(workDir, { recursive: true, force: true });
	});

	it("creates a Whiteboard with inlined nodes + edge entities, idempotently", async () => {
		const session = getActiveVaultSession();
		if (!session) throw new Error("no session");
		const opts = { source: "obsidian:cv", now: 1_700_000_000_000, importedBy: "shell:import" };
		const files = [{ path: "Boards/Plan.canvas", name: "Plan", json: CANVAS }];

		const first = await importObsidianCanvas(session, files, opts);
		expect(first.boardsCreated).toBe(1);
		expect(first.edgesCreated).toBe(1);

		const repo = new EntitiesRepository(await session.dataStores.open("entities"));
		const board = repo.query({ type: [WHITEBOARD_TYPE] })[0];
		expect(board?.properties.name).toBe("Plan");
		expect((board?.properties.nodes as unknown[]).length).toBe(5);
		expect(repo.query({ type: [WHITEBOARD_EDGE_TYPE] })).toHaveLength(1);

		const second = await importObsidianCanvas(session, files, opts);
		expect(second.boardsCreated).toBe(0);
		expect(second.boardsUpdated).toBe(1);
		expect(second.edgesCreated).toBe(0);
		expect(repo.query({ type: [WHITEBOARD_TYPE] })).toHaveLength(1);
		expect(repo.query({ type: [WHITEBOARD_EDGE_TYPE] })).toHaveLength(1);
	});
});
