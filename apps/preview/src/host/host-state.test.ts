/**
 * Pure host-state model — cursor + siblings + wrap semantics.
 */
import { describe, expect, it } from "vitest";
import type { PreviewFile } from "../demo/dataset";
import { activeFile, indexOfId, initState, jumpTo, removeById, step } from "./host-state";

function fakeFile(id: string): PreviewFile {
	return {
		id,
		info: { name: `${id}.txt`, mime: "text/plain", sizeBytes: 0, modifiedAt: 0 },
		source: { kind: "bytes", bytes: new Uint8Array(0), mime: "text/plain" },
	};
}

describe("host-state", () => {
	it("initState clamps an out-of-range cursor to a valid index", () => {
		const s = initState([fakeFile("a"), fakeFile("b")], 99);
		expect(s.cursor).toBe(1);
	});

	it("initState with an empty siblings list keeps cursor=0", () => {
		const s = initState([], 0);
		expect(s.cursor).toBe(0);
		expect(activeFile(s)).toBeNull();
	});

	it("step wraps forward past the end", () => {
		const s = initState([fakeFile("a"), fakeFile("b"), fakeFile("c")], 2);
		expect(step(s, 1).cursor).toBe(0);
	});

	it("step wraps backward past the start", () => {
		const s = initState([fakeFile("a"), fakeFile("b"), fakeFile("c")], 0);
		expect(step(s, -1).cursor).toBe(2);
	});

	it("step is a no-op on an empty siblings list", () => {
		const s = initState([], 0);
		expect(step(s, 1)).toBe(s);
	});

	it("jumpTo clamps out-of-range indices into valid range", () => {
		const s = initState([fakeFile("a"), fakeFile("b")], 0);
		expect(jumpTo(s, -5).cursor).toBe(0);
		expect(jumpTo(s, 99).cursor).toBe(1);
	});

	it("activeFile returns the entry at the cursor", () => {
		const s = initState([fakeFile("a"), fakeFile("b"), fakeFile("c")], 1);
		expect(activeFile(s)?.id).toBe("b");
	});

	it("indexOfId returns the position or -1", () => {
		const s = initState([fakeFile("a"), fakeFile("b"), fakeFile("c")], 0);
		expect(indexOfId(s, "b")).toBe(1);
		expect(indexOfId(s, "missing")).toBe(-1);
	});

	it("removeById keeps the cursor on the file that slides into the removed slot", () => {
		const files = [fakeFile("a"), fakeFile("b"), fakeFile("c")];
		expect(activeFile(removeById(initState(files, 1), "b"))?.id).toBe("c");
		expect(activeFile(removeById(initState(files, 2), "c"))?.id).toBe("b");
		expect(activeFile(removeById(initState(files, 2), "a"))?.id).toBe("c");
		const emptied = removeById(initState([fakeFile("a")], 0), "a");
		expect(emptied.siblings).toHaveLength(0);
		expect(activeFile(emptied)).toBeNull();
		const same = initState(files, 0);
		expect(removeById(same, "zzz")).toBe(same);
	});
});
