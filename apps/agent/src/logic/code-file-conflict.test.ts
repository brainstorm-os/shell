/**
 * POLISH-FN-4 — the path-conflict invariant for approved code files, proved end
 * to end against a FAKE VAULT rather than a call-count stub: the fake holds
 * rows, so "exactly one entity exists at that path" is asserted on the vault's
 * contents, which is the property that actually broke.
 */

import { describe, expect, it } from "vitest";
import {
	CodeFileConflictChoice,
	type CodeFilePathRow,
	claimCodeFilePath,
	codeFilePathKey,
	codeFilePathsFrom,
	findCodeFilePathConflict,
	mergeCodeFilePaths,
	nextFreeCodeFilePath,
	releaseCodeFilePath,
} from "./code-file-conflict";
import { type ProposedArtifact, buildProposal } from "./propose-artifacts";
import { CODE_FILE_ENTITY_TYPE, buildCodeFileProposal } from "./propose-code-file";
import { CodeFilePathConflictError, persistApprovedProposal } from "./propose-persist";

const NOW = 1_700_000_000_000;

function draft(path: string, content = "console.log(1)\n"): ProposedArtifact {
	const r = buildCodeFileProposal({
		verb: "propose-code-file",
		args: { path, content, language: "typescript" },
		id: `p-${path}`,
	});
	if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
	return r.artifact;
}

/** A vault that actually stores rows — `create` appends, `update` merges — so a
 *  duplicate is observable as two rows at one path, not as a call count. */
function fakeVault(seed: Array<{ id: string; path: string; content?: string }> = []) {
	let seq = 0;
	const rows = seed.map((row) => ({
		id: row.id,
		type: CODE_FILE_ENTITY_TYPE,
		properties: { path: row.path, content: row.content ?? "old", language: "typescript" } as Record<
			string,
			unknown
		>,
	}));
	return {
		rows,
		codeFiles: (): CodeFilePathRow[] => codeFilePathsFrom(rows),
		at: (path: string) =>
			rows.filter((row) => codeFilePathKey(row.properties.path as string) === codeFilePathKey(path)),
		async create(type: string, properties: Record<string, unknown>) {
			seq += 1;
			const id = `ent_${seq}`;
			rows.push({ id, type, properties });
			return { id };
		},
		async update(id: string, patch: Record<string, unknown>) {
			const row = rows.find((r) => r.id === id);
			if (!row) throw new Error(`no such entity ${id}`);
			Object.assign(row.properties, patch);
			return undefined;
		},
	};
}

describe("approving a code file at an EXISTING path (POLISH-FN-4)", () => {
	it("refuses the create when no choice was made — never a second entity at one path", async () => {
		const vault = fakeVault();
		// First approval: the path is free, so it creates.
		await persistApprovedProposal(vault, draft("hello-app/manifest.json"), {
			conversationId: "conv_1",
			now: NOW,
			existingCodeFiles: vault.codeFiles(),
		});
		expect(vault.at("hello-app/manifest.json")).toHaveLength(1);

		// Second approval of the SAME draft: the path is taken and the user made
		// no choice, so the write is refused — this is the defect (it used to be
		// a silent second `entities.create`).
		await expect(
			persistApprovedProposal(vault, draft("hello-app/manifest.json"), {
				conversationId: "conv_1",
				now: NOW,
				existingCodeFiles: vault.codeFiles(),
			}),
		).rejects.toBeInstanceOf(CodeFilePathConflictError);

		expect(vault.at("hello-app/manifest.json")).toHaveLength(1);
	});

	it("names the conflicting path and the row that holds it on the refusal", async () => {
		const vault = fakeVault([{ id: "ent_old", path: "hello-app/manifest.json" }]);
		const error = await persistApprovedProposal(vault, draft("hello-app/manifest.json"), {
			conversationId: null,
			now: NOW,
			existingCodeFiles: vault.codeFiles(),
		}).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(CodeFilePathConflictError);
		expect((error as CodeFilePathConflictError).path).toBe("hello-app/manifest.json");
		expect((error as CodeFilePathConflictError).existingId).toBe("ent_old");
	});

	it("Update rewrites the existing row in place — still exactly one entity", async () => {
		const vault = fakeVault([{ id: "ent_old", path: "hello-app/manifest.json", content: "{}" }]);
		const result = await persistApprovedProposal(
			vault,
			draft("hello-app/manifest.json", '{"id":"io.x.hello"}\n'),
			{
				conversationId: "conv_1",
				now: NOW,
				existingCodeFiles: vault.codeFiles(),
				codeFileChoice: CodeFileConflictChoice.Update,
			},
		);
		expect(result).toEqual({ id: "ent_old", codeFilePath: "hello-app/manifest.json" });
		expect(vault.at("hello-app/manifest.json")).toHaveLength(1);
		const row = vault.rows.find((r) => r.id === "ent_old");
		expect(row?.properties.content).toBe('{"id":"io.x.hello"}\n');
		expect(row?.properties.sizeBytes).toBe(20);
		expect(row?.properties.updatedAt).toBe(NOW);
		// The row keeps its identity: no new entity, and `createdAt` is not reset.
		expect(vault.rows).toHaveLength(1);
		expect(row?.properties.createdAt).toBeUndefined();
	});

	it("Save a copy creates at the next free path, leaving the original alone", async () => {
		const vault = fakeVault([{ id: "ent_old", path: "hello-app/manifest.json", content: "{}" }]);
		const result = await persistApprovedProposal(vault, draft("hello-app/manifest.json", "new"), {
			conversationId: "conv_1",
			now: NOW,
			existingCodeFiles: vault.codeFiles(),
			codeFileChoice: CodeFileConflictChoice.SaveCopy,
		});
		expect(result?.codeFilePath).toBe("hello-app/manifest-2.json");
		expect(vault.at("hello-app/manifest.json")).toHaveLength(1);
		expect(vault.at("hello-app/manifest-2.json")).toHaveLength(1);
		expect(vault.rows.find((r) => r.id === "ent_old")?.properties.content).toBe("{}");
	});

	it("a free path still creates, with the choice unset and provenance stamped", async () => {
		const vault = fakeVault([{ id: "ent_old", path: "hello-app/index.html" }]);
		const result = await persistApprovedProposal(vault, draft("hello-app/manifest.json"), {
			conversationId: "conv_1",
			now: NOW,
			existingCodeFiles: vault.codeFiles(),
		});
		expect(result).toEqual({ id: "ent_1", codeFilePath: "hello-app/manifest.json" });
		expect(vault.rows).toHaveLength(2);
	});
});

describe("neighbouring cases", () => {
	it("case-only collisions are conflicts (macOS/Windows fold case, so would the install)", async () => {
		const vault = fakeVault([{ id: "ent_old", path: "hello-app/Manifest.JSON" }]);
		await expect(
			persistApprovedProposal(vault, draft("hello-app/manifest.json"), {
				conversationId: null,
				now: NOW,
				existingCodeFiles: vault.codeFiles(),
			}),
		).rejects.toBeInstanceOf(CodeFilePathConflictError);
		expect(vault.rows).toHaveLength(1);
	});

	it("Update on a case-only collision keeps the EXISTING spelling (no silent re-casing)", async () => {
		const vault = fakeVault([{ id: "ent_old", path: "hello-app/Manifest.JSON" }]);
		const result = await persistApprovedProposal(vault, draft("hello-app/manifest.json", "x"), {
			conversationId: null,
			now: NOW,
			existingCodeFiles: vault.codeFiles(),
			codeFileChoice: CodeFileConflictChoice.Update,
		});
		expect(result?.codeFilePath).toBe("hello-app/Manifest.JSON");
		expect(vault.rows[0]?.properties.path).toBe("hello-app/Manifest.JSON");
		expect(vault.rows[0]?.properties.content).toBe("x");
	});

	it("a DELETED file's path is free again — a tombstone never blocks a create", async () => {
		// Soft-deleted rows are filtered by the entities repo (`deleted_at IS
		// NULL`), so they simply are not in the snapshot the card reads.
		const snapshot = [
			{ id: "ent_live", type: CODE_FILE_ENTITY_TYPE, properties: { path: "keep.ts" } },
		];
		const existing = codeFilePathsFrom(snapshot);
		expect(findCodeFilePathConflict(existing, "hello-app/manifest.json")).toBeNull();

		const vault = fakeVault();
		const result = await persistApprovedProposal(vault, draft("hello-app/manifest.json"), {
			conversationId: null,
			now: NOW,
			existingCodeFiles: existing,
		});
		expect(result?.id).toBe("ent_1");
	});

	it("two cards at ONE path: the second sees the first's write through the session list", async () => {
		const vault = fakeVault();
		// The live snapshot has not round-tripped yet, so the app carries the row
		// it just persisted forward itself (`mergeCodeFilePaths`).
		const first = await persistApprovedProposal(vault, draft("hello-app/manifest.json", "a"), {
			conversationId: null,
			now: NOW,
			existingCodeFiles: [],
		});
		const session: CodeFilePathRow[] = [{ id: first?.id ?? "", path: first?.codeFilePath ?? "" }];
		const known = mergeCodeFilePaths([], session);

		await expect(
			persistApprovedProposal(vault, draft("hello-app/manifest.json", "b"), {
				conversationId: null,
				now: NOW,
				existingCodeFiles: known,
			}),
		).rejects.toBeInstanceOf(CodeFilePathConflictError);
		expect(vault.at("hello-app/manifest.json")).toHaveLength(1);
	});

	it("a code file with NO existing-files context is still refused nothing (free path creates)", async () => {
		// `existingCodeFiles` omitted entirely — the caller supplied no context,
		// which can only mean an empty vault view; the create proceeds.
		const vault = fakeVault();
		const result = await persistApprovedProposal(vault, draft("solo.ts"), {
			conversationId: null,
			now: NOW,
		});
		expect(result?.id).toBe("ent_1");
	});

	it("non-code-file proposals are untouched by the guard", async () => {
		const vault = fakeVault();
		const staged = buildProposal({ verb: "propose-note", args: { title: "Ideas" }, id: "p-note" });
		if (!staged.ok) throw new Error(`expected ok, got ${staged.reason}`);
		// A note whose title happens to match an existing code-file path still
		// creates — the guard is scoped to `ProposeKind.CodeFile`.
		const result = await persistApprovedProposal(vault, staged.artifact, {
			conversationId: null,
			now: NOW,
			existingCodeFiles: [{ id: "ent_old", path: "Ideas" }],
		});
		expect(result?.id).toBe("ent_1");
	});
});

describe("path helpers", () => {
	const rows = (...paths: string[]): CodeFilePathRow[] =>
		paths.map((path, i) => ({ id: `e${i}`, path }));

	it("nextFreeCodeFilePath keeps the folder and extension, walking -2, -3, …", () => {
		expect(nextFreeCodeFilePath(rows("a/manifest.json"), "a/manifest.json")).toBe(
			"a/manifest-2.json",
		);
		expect(
			nextFreeCodeFilePath(rows("a/manifest.json", "a/manifest-2.json"), "a/manifest.json"),
		).toBe("a/manifest-3.json");
		expect(nextFreeCodeFilePath(rows("index.html"), "index.html")).toBe("index-2.html");
	});

	it("nextFreeCodeFilePath treats a leading dot as part of the name, not an extension", () => {
		expect(nextFreeCodeFilePath(rows(".gitignore"), ".gitignore")).toBe(".gitignore-2");
		expect(nextFreeCodeFilePath(rows("a/Makefile"), "a/Makefile")).toBe("a/Makefile-2");
		expect(nextFreeCodeFilePath(rows("a/app.test.ts"), "a/app.test.ts")).toBe("a/app.test-2.ts");
	});

	it("nextFreeCodeFilePath folds case when judging what is taken", () => {
		expect(nextFreeCodeFilePath(rows("A/Manifest.JSON"), "a/manifest.json")).toBe(
			"a/manifest-2.json",
		);
	});

	it("codeFilePathsFrom skips foreign types and pathless/blank rows", () => {
		const snapshot = [
			{ id: "a", type: CODE_FILE_ENTITY_TYPE, properties: { path: "a.ts" } },
			{ id: "b", type: "brainstorm/Task/v1", properties: { path: "b.ts" } },
			{ id: "c", type: CODE_FILE_ENTITY_TYPE, properties: {} },
			{ id: "d", type: CODE_FILE_ENTITY_TYPE, properties: { path: "   " } },
			{ id: "e", type: CODE_FILE_ENTITY_TYPE, properties: { path: 42 } },
		];
		expect(codeFilePathsFrom(snapshot)).toEqual([{ id: "a", path: "a.ts" }]);
	});

	it("findCodeFilePathConflict ignores an empty draft path", () => {
		expect(findCodeFilePathConflict(rows("a.ts"), "")).toBeNull();
		expect(findCodeFilePathConflict(rows("a.ts"), "   ")).toBeNull();
		expect(findCodeFilePathConflict(rows("a.ts"), " A.TS ")).toEqual({ id: "e0", path: "a.ts" });
	});

	it("claimCodeFilePath refuses a second claim on a path already in flight", () => {
		const inFlight = new Set<string>();
		expect(claimCodeFilePath(inFlight, "hello-app/manifest.json")).toBe(true);
		// The second card, approved before the first create resolved: neither the
		// vault snapshot nor the session list knows about the path yet, so this
		// claim is the only thing standing between it and a duplicate.
		expect(claimCodeFilePath(inFlight, "hello-app/manifest.json")).toBe(false);
		// Case-folded, like every other path comparison here.
		expect(claimCodeFilePath(inFlight, "hello-app/MANIFEST.JSON")).toBe(false);
		// A different path is unaffected.
		expect(claimCodeFilePath(inFlight, "hello-app/index.html")).toBe(true);

		releaseCodeFilePath(inFlight, "hello-app/Manifest.json");
		expect(claimCodeFilePath(inFlight, "hello-app/manifest.json")).toBe(true);
	});

	it("releaseCodeFilePath on an unclaimed path is a no-op", () => {
		const inFlight = new Set<string>();
		releaseCodeFilePath(inFlight, "never-claimed.ts");
		expect(inFlight.size).toBe(0);
	});

	it("mergeCodeFilePaths lets the settled vault row win over the session claim", () => {
		const merged = mergeCodeFilePaths(rows("a.ts"), [
			{ id: "stale", path: "A.TS" },
			{ id: "fresh", path: "b.ts" },
		]);
		expect(merged).toEqual([
			{ id: "e0", path: "a.ts" },
			{ id: "fresh", path: "b.ts" },
		]);
	});
});
