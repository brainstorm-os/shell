/**
 * IE-5 Obsidian importer. The pure `parseObsidianVault` is tested directly; the
 * `importObsidianVault` vault binding runs against a real session (Electron
 * mocked) so idempotent upsert + link rebuild are proven end-to-end.
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
	type ObsidianFile,
	ObsidianLinkKind,
	importObsidianVault,
	parseObsidianVault,
} from "./obsidian-import";

const FILES: ObsidianFile[] = [
	{
		path: "Ideas/Alpha.md",
		text:
			"---\ntitle: Alpha Note\nstatus: open\n---\nLinks to [[Beta]] and ![[Gamma]] #project #project/sub\n",
	},
	{ path: "Beta.md", text: "Plain note pointing back to [[Alpha|the first]].\n" },
	{ path: "Gamma.md", text: "Embedded.\n" },
	{ path: "Dangling.md", text: "Points to [[Nonexistent#heading]].\n" },
	{ path: "attachment.png", text: "binary-ish" },
];

describe("parseObsidianVault (pure)", () => {
	it("maps frontmatter → properties + body + tags and ignores non-md files", () => {
		const plan = parseObsidianVault(FILES);
		expect(plan.entities).toHaveLength(4); // attachment.png ignored
		const alpha = plan.entities.find((e) => e.noteName === "Alpha");
		expect(alpha?.title).toBe("Alpha Note");
		expect(alpha?.properties.status).toBe("open");
		expect(alpha?.properties.body).toContain("Links to");
		expect(alpha?.tags).toEqual(["project", "project/sub"]);
		expect(alpha?.externalId).toBe("Ideas/Alpha.md");
	});

	it("resolves wikilinks (alias/heading/path stripped, case-insensitive) + embed kind", () => {
		const plan = parseObsidianVault(FILES);
		const fromAlpha = plan.links.filter((l) => l.fromNote === "Alpha");
		expect(fromAlpha).toContainEqual({
			fromNote: "Alpha",
			toNote: "Beta",
			kind: ObsidianLinkKind.Reference,
		});
		expect(fromAlpha).toContainEqual({
			fromNote: "Alpha",
			toNote: "Gamma",
			kind: ObsidianLinkKind.Embed,
		});
		// Beta → Alpha via [[Alpha|the first]] (alias stripped).
		expect(plan.links).toContainEqual({
			fromNote: "Beta",
			toNote: "Alpha",
			kind: ObsidianLinkKind.Reference,
		});
	});

	it("surfaces dangling wikilinks instead of dropping them", () => {
		const plan = parseObsidianVault(FILES);
		expect(plan.unresolved).toContainEqual({ fromNote: "Dangling", target: "Nonexistent" });
		expect(plan.links.some((l) => l.fromNote === "Dangling")).toBe(false);
	});

	it("resolves attachment embeds against the attachment file set", () => {
		const files: ObsidianFile[] = [
			{ path: "Note.md", text: "Diagram: ![[diagram.png]] and ![[Missing.png]]\n" },
		];
		const plan = parseObsidianVault(files, ["assets/diagram.png"]);
		expect(plan.attachmentLinks).toEqual([
			{ fromNote: "Note", attachmentPath: "assets/diagram.png", kind: ObsidianLinkKind.Embed },
		]);
		expect(plan.referencedAttachments).toEqual(["assets/diagram.png"]);
		// The unknown attachment stays unresolved, not silently dropped.
		expect(plan.unresolved).toContainEqual({ fromNote: "Note", target: "Missing.png" });
	});
});

describe("importObsidianVault (vault binding)", () => {
	let workDir = "";

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "bs-obsidian-"));
		USER_DATA_DIR = workDir;
		__setSqlcipherDriverForTests(null);
		__resetAtRestProbeForTests();
		await createVault({
			name: "OB",
			path: join(workDir, "vault"),
			keystore: { forceInsecure: true },
			seedStarterContent: false,
		});
	});

	afterEach(async () => {
		closeActiveVaultSession();
		await rm(workDir, { recursive: true, force: true });
	});

	it("creates notes + links, then re-imports idempotently (updates, no dupes)", async () => {
		const session = getActiveVaultSession();
		if (!session) throw new Error("no session");
		const opts = {
			targetType: "test/Note/v1",
			source: "obsidian:v1",
			now: 1_700_000_000_000,
			importedBy: "shell:import",
		};

		const first = await importObsidianVault(session, FILES, opts);
		expect(first.created).toBe(4);
		expect(first.updated).toBe(0);
		// Alpha→Beta, Alpha→Gamma, Beta→Alpha = 3 resolved links; Dangling unresolved.
		expect(first.linked).toBe(3);
		expect(first.unresolved).toBe(1);

		const repo = new EntitiesRepository(await session.dataStores.open("entities"));
		const ids = repo.query({ type: ["test/Note/v1"] }).map((e) => e.id);
		expect(ids).toHaveLength(4);
		expect(repo.linksFromMany(ids)).toHaveLength(3);

		const second = await importObsidianVault(session, FILES, opts);
		expect(second.created).toBe(0);
		expect(second.updated).toBe(4);
		const ids2 = repo.query({ type: ["test/Note/v1"] }).map((e) => e.id);
		expect(ids2).toHaveLength(4); // no duplicate entities
		expect(repo.linksFromMany(ids2)).toHaveLength(3); // no duplicate links on re-import
	});

	it("streams note progress and cancels on an aborted signal", async () => {
		const session = getActiveVaultSession();
		if (!session) throw new Error("no session");
		const base = { targetType: "test/Note/v1", now: 1_700_000_000_000, importedBy: "shell:import" };
		const ticks: Array<[number, number]> = [];
		const report = await importObsidianVault(session, FILES, {
			...base,
			source: "obsidian:prog",
			onProgress: (done, total) => ticks.push([done, total]),
		});
		expect(report.created).toBe(4);
		expect(ticks.at(-1)).toEqual([4, 4]);

		const controller = new AbortController();
		controller.abort();
		const cancelled = await importObsidianVault(session, FILES, {
			...base,
			source: "obsidian:cancel",
			signal: controller.signal,
		});
		expect(cancelled.created).toBe(0);
		expect(cancelled.cancelled).toBe(true);
		expect(cancelled.linked).toBe(0); // links skipped when cancelled mid-notes
	});

	it("imports a referenced attachment as a File/v1 and links the note to it", async () => {
		const session = getActiveVaultSession();
		if (!session) throw new Error("no session");
		const opts = {
			targetType: "test/Note/v1",
			source: "obsidian:att",
			now: 1_700_000_000_000,
			importedBy: "shell:import",
		};
		const files: ObsidianFile[] = [{ path: "Spec.md", text: "Layout: ![[wire.png]]\n" }];
		const attachments = [{ path: "assets/wire.png", bytes: new Uint8Array([1, 2, 3, 4]) }];

		const report = await importObsidianVault(session, files, opts, attachments);
		expect(report.filesCreated).toBe(1);
		expect(report.linked).toBe(1);

		const repo = new EntitiesRepository(await session.dataStores.open("entities"));
		const file = repo
			.query({ type: ["brainstorm/File/v1"] })
			.find((e) => e.properties.name === "wire.png");
		expect(file).toBeDefined();
		expect(file?.properties.mime).toBe("image/png");
		expect(typeof file?.properties.assetId).toBe("string");
		expect(file?.properties.attachment).toBe(`brainstorm://asset/${file?.properties.assetId}`);
		// The note links to the imported file as an embed.
		const note = repo.query({ type: ["test/Note/v1"] }).find((e) => e.properties.title === "Spec");
		const outgoing = repo.linksFrom(note?.id ?? "");
		expect(outgoing.some((l) => l.destEntityId === file?.id)).toBe(true);

		// Re-import: no duplicate File/v1, no duplicate link.
		await importObsidianVault(session, files, opts, attachments);
		expect(repo.query({ type: ["brainstorm/File/v1"] })).toHaveLength(1);
		expect(repo.linksFrom(note?.id ?? "")).toHaveLength(1);
	});
});
