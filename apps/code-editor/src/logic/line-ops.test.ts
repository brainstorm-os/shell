import { CodeLanguage } from "@brainstorm-os/sdk/language-detect";
import { describe, expect, it } from "vitest";
import {
	type BufferSelection,
	LineMoveDirection,
	deleteLines,
	duplicateLines,
	lineCommentToken,
	moveLines,
	toggleLineComment,
} from "./line-ops";

function sel(text: string, selStart: number, selEnd = selStart): BufferSelection {
	return { text, selStart, selEnd };
}

describe("moveLines", () => {
	it("moves a single line down and carries the caret", () => {
		const r = moveLines(sel("a\nb\nc", 0), LineMoveDirection.Down);
		expect(r.text).toBe("b\na\nc");
		expect(r).toMatchObject({ selStart: 2, selEnd: 2 }); // start of the moved "a"
	});

	it("moves a single line up and carries the caret", () => {
		const r = moveLines(sel("a\nb\nc", 2), LineMoveDirection.Up); // caret on "b"
		expect(r.text).toBe("b\na\nc");
		expect(r).toMatchObject({ selStart: 0, selEnd: 0 });
	});

	it("is a no-op moving the first line up (returns input)", () => {
		const input = sel("a\nb", 0);
		expect(moveLines(input, LineMoveDirection.Up)).toBe(input);
	});

	it("is a no-op moving the last line down (returns input)", () => {
		const input = sel("a\nb", 2);
		expect(moveLines(input, LineMoveDirection.Down)).toBe(input);
	});

	it("moves a multi-line block down and shifts the whole selection", () => {
		// select lines "a" and "b" (offsets 0..3 = start of "c")
		const r = moveLines(sel("a\nb\nc\nd", 0, 3), LineMoveDirection.Down);
		expect(r.text).toBe("c\na\nb\nd");
		expect(r).toMatchObject({ selStart: 2, selEnd: 5 });
	});

	it("does not pull in a trailing line when the selection ends at its start", () => {
		// selection 0..2 ends exactly at the start of line "b" → only "a" moves
		const r = moveLines(sel("a\nb\nc", 0, 2), LineMoveDirection.Down);
		expect(r.text).toBe("b\na\nc");
	});
});

describe("duplicateLines", () => {
	it("duplicates downward and moves the selection onto the copy", () => {
		const r = duplicateLines(sel("a\nb", 0), LineMoveDirection.Down);
		expect(r.text).toBe("a\na\nb");
		expect(r).toMatchObject({ selStart: 2, selEnd: 2 }); // the copy
	});

	it("duplicates upward and keeps the selection in place", () => {
		const r = duplicateLines(sel("a\nb", 0), LineMoveDirection.Up);
		expect(r.text).toBe("a\na\nb");
		expect(r).toMatchObject({ selStart: 0, selEnd: 0 });
	});

	it("duplicates a multi-line block downward", () => {
		const r = duplicateLines(sel("a\nb\nc", 0, 3), LineMoveDirection.Down);
		expect(r.text).toBe("a\nb\na\nb\nc");
	});
});

describe("deleteLines", () => {
	it("deletes the caret line and preserves the column on the next line", () => {
		const r = deleteLines(sel("aa\nbb\ncc", 4)); // caret on "bb" col 1
		expect(r.text).toBe("aa\ncc");
		expect(r).toMatchObject({ selStart: 4, selEnd: 4 }); // "cc" col 1
	});

	it("collapses to an empty buffer when the only line is deleted", () => {
		const r = deleteLines(sel("only", 2));
		expect(r.text).toBe("");
		expect(r).toMatchObject({ selStart: 0, selEnd: 0 });
	});

	it("deletes every line touched by a multi-line selection", () => {
		const r = deleteLines(sel("a\nb\nc\nd", 0, 3)); // "a" + "b"
		expect(r.text).toBe("c\nd");
	});

	it("clamps the caret onto the last line when deleting the tail", () => {
		const r = deleteLines(sel("a\nb\nc", 4)); // caret on "c" (last line)
		expect(r.text).toBe("a\nb");
		expect(r.selStart).toBeLessThanOrEqual(r.text.length);
	});

	it("preserves the column for a reversed selection (selStart > selEnd)", () => {
		// Reversed single-line selection on "bb" col 0..2; anchor column is 0.
		const r = deleteLines({ text: "aa\nbb\ncc", selStart: 5, selEnd: 3 });
		expect(r.text).toBe("aa\ncc");
		expect(r).toMatchObject({ selStart: 3, selEnd: 3 }); // "cc" col 0, not end-of-line
	});
});

describe("lineCommentToken", () => {
	it("maps slash-comment languages", () => {
		expect(lineCommentToken(CodeLanguage.TypeScript)).toBe("//");
		expect(lineCommentToken(CodeLanguage.Rust)).toBe("//");
	});

	it("maps hash- and dash-comment languages", () => {
		expect(lineCommentToken(CodeLanguage.Python)).toBe("#");
		expect(lineCommentToken(CodeLanguage.SQL)).toBe("--");
	});

	it("returns null for languages without a line comment", () => {
		expect(lineCommentToken(CodeLanguage.JSON)).toBeNull();
		expect(lineCommentToken(CodeLanguage.CSS)).toBeNull();
		expect(lineCommentToken(CodeLanguage.Markdown)).toBeNull();
		expect(lineCommentToken(CodeLanguage.PlainText)).toBeNull();
	});
});

describe("toggleLineComment", () => {
	const slash = "//";

	it("is a no-op when the language has no line comment token", () => {
		const input = sel("const x = 1", 0);
		expect(toggleLineComment(input, null)).toBe(input);
	});

	it("comments a single line at its indentation column", () => {
		const r = toggleLineComment(sel("  const x = 1", 0), slash);
		expect(r.text).toBe("  // const x = 1");
	});

	it("shifts a caret that sits after the insertion point", () => {
		const r = toggleLineComment(sel("  const", 5), slash); // inside "const"
		expect(r.text).toBe("  // const");
		expect(r.selStart).toBe(8); // 5 + len("// ")
	});

	it("keeps a line-start caret before the inserted token", () => {
		const r = toggleLineComment(sel("  const", 0), slash);
		expect(r.selStart).toBe(0);
	});

	it("uncomments a commented line and removes the trailing space", () => {
		const r = toggleLineComment(sel("  // const x = 1", 0), slash);
		expect(r.text).toBe("  const x = 1");
	});

	it("uncomments when there is no space after the token", () => {
		const r = toggleLineComment(sel("//const", 0), slash);
		expect(r.text).toBe("const");
	});

	it("round-trips comment then uncomment back to the original", () => {
		const original = sel("    return value", 7);
		const commented = toggleLineComment(original, slash);
		const back = toggleLineComment(commented, slash);
		expect(back.text).toBe(original.text);
		expect(back.selStart).toBe(original.selStart);
	});

	it("aligns the comment token at the minimum shared indentation", () => {
		// tokens align at column 2; the deeper line keeps its relative indent
		const r = toggleLineComment(sel("  a\n    b", 0, 9), slash);
		expect(r.text).toBe("  // a\n  //   b");
	});

	it("comments all lines when the block is mixed (some already commented)", () => {
		const r = toggleLineComment(sel("// a\nb", 0, 6), slash);
		expect(r.text).toBe("// // a\n// b");
	});

	it("skips blank lines inside the selected range", () => {
		const r = toggleLineComment(sel("a\n\nb", 0, 4), slash);
		expect(r.text).toBe("// a\n\n// b");
	});

	it("is a no-op when the only selected lines are blank", () => {
		const input = sel("\n\n", 0, 2);
		expect(toggleLineComment(input, slash)).toBe(input);
	});

	it("extends a full-line selection over the commented block", () => {
		const r = toggleLineComment(sel("a\nb", 0, 3), slash);
		expect(r.text).toBe("// a\n// b");
		expect(r).toMatchObject({ selStart: 0, selEnd: r.text.length });
	});
});
