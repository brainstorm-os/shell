/**
 * The Code-editor write gate — Lock-5(l).
 *
 * `isCodeFileEditable(row)` already folded the lock in, and drove the pane's
 * read-only state and the language dropdown. Three writers never asked it: the
 * SAVE (which writes the file's whole content), the rename (path + language),
 * and the folder move that re-paths a batch at once. A locked file was saved
 * over, renamed and moved.
 *
 * These tests drive the funnel and assert on `entities.update`.
 */

import { describe, expect, it, vi } from "vitest";
import {
	type CodeWriteContext,
	codeFileLocked,
	codeWriteRefused,
	writeCodeFilePatch,
} from "./code-file-writes";
import type { CodeFileRow } from "./code-projection";

function row(id: string, over: Partial<CodeFileRow> = {}): CodeFileRow {
	return {
		id,
		path: `src/${id}.ts`,
		content: "",
		contentKey: "content",
		language: "typescript",
		locked: false,
		...over,
	} as CodeFileRow;
}

function ctx(list: CodeFileRow[]): CodeWriteContext & { update: ReturnType<typeof vi.fn> } {
	const update = vi.fn(() => Promise.resolve(null));
	return { find: (id) => list.find((r) => r.id === id), update };
}

describe("codeFileLocked", () => {
	it("reads the stored row's lock, and treats a missing row as unlocked", () => {
		const c = ctx([row("a", { locked: true }), row("b")]);
		expect(codeFileLocked(c, "a")).toBe(true);
		expect(codeFileLocked(c, "b")).toBe(false);
		expect(codeFileLocked(c, "gone")).toBe(false);
	});
});

describe("writeCodeFilePatch", () => {
	it("saves content on an unlocked file", async () => {
		const c = ctx([row("a")]);
		expect(await writeCodeFilePatch(c, "a", { content: "export const x = 1;" })).toBe(true);
		expect(c.update).toHaveBeenCalledWith("a", { content: "export const x = 1;" });
	});

	it("refuses the SAVE on a locked file — the content write, not just the pane", async () => {
		const c = ctx([row("a", { locked: true })]);
		expect(await writeCodeFilePatch(c, "a", { content: "overwritten" })).toBe(false);
		expect(c.update).not.toHaveBeenCalled();
	});

	it("refuses the rename and the folder move on a locked file", async () => {
		const c = ctx([row("a", { locked: true })]);
		expect(await writeCodeFilePatch(c, "a", { path: "src/renamed.ts" })).toBe(false);
		expect(await writeCodeFilePatch(c, "a", { path: "src/renamed.ts", language: "python" })).toBe(
			false,
		);
		expect(c.update).not.toHaveBeenCalled();
	});

	it("lets the lock-flip through, and refuses a mixed patch wholesale", async () => {
		const c = ctx([row("a", { locked: true })]);
		expect(await writeCodeFilePatch(c, "a", { locked: false })).toBe(true);
		expect(await writeCodeFilePatch(c, "a", { locked: false, content: "sneaky" })).toBe(false);
		expect(c.update).toHaveBeenCalledTimes(1);
	});

	it("moves the unlocked rows of a batch and leaves the locked one where it is", async () => {
		const c = ctx([row("a"), row("b", { locked: true }), row("c")]);
		for (const id of ["a", "b", "c"]) await writeCodeFilePatch(c, id, { path: `lib/${id}.ts` });
		expect(c.update).toHaveBeenCalledTimes(2);
		expect(c.update).not.toHaveBeenCalledWith("b", expect.anything());
	});

	it("reports false (and writes nothing) with no entities service", async () => {
		expect(
			await writeCodeFilePatch({ find: () => row("a"), update: undefined }, "a", { content: "x" }),
		).toBe(false);
	});
});

describe("codeWriteRefused", () => {
	it("refuses a patch-less write on a locked file", () => {
		const c = ctx([row("a", { locked: true }), row("b")]);
		expect(codeWriteRefused(c, "a")).toBe(true);
		expect(codeWriteRefused(c, "b")).toBe(false);
	});
});
