/**
 * Line & block operations (9.7.4) — pure buffer transforms.
 *
 * Each operation maps a `{ text, selStart, selEnd }` snapshot to the same
 * shape after the edit, carrying the selection across so the caller can
 * restore it on the textarea. There is no DOM here on purpose: line ops
 * are the kind of caret-arithmetic that is only trustworthy when pinned
 * by tests, so they live in a pure module and the code-pane just applies
 * the result (mirrors how `diffStrings` in `code-y-buffer.ts` stays pure).
 *
 * Selection convention matches common editors: the affected line range
 * spans from the line containing `selStart` to the line containing
 * `selEnd`, EXCEPT a non-empty selection ending exactly at a line start
 * does not pull in that trailing line (you selected up to it, not into
 * it). Offsets may arrive reversed (`selStart > selEnd`); operations
 * preserve the pair as given since both endpoints shift together.
 */

import { CodeLanguage } from "@brainstorm-os/sdk/language-detect";

export enum LineMoveDirection {
	Up = "up",
	Down = "down",
}

export interface BufferSelection {
	text: string;
	selStart: number;
	selEnd: number;
}

/** Per-language single-line comment token. Languages with only block
 *  comments (CSS, HTML), data formats without comments (strict JSON), or
 *  prose (Markdown / plain text) map to `null` — comment-toggle is a
 *  no-op there rather than corrupting the buffer with a wrong token. */
const LINE_COMMENT_TOKENS: Partial<Record<CodeLanguage, string>> = {
	[CodeLanguage.TypeScript]: "//",
	[CodeLanguage.JavaScript]: "//",
	[CodeLanguage.TSX]: "//",
	[CodeLanguage.JSX]: "//",
	[CodeLanguage.JSONC]: "//",
	[CodeLanguage.Rust]: "//",
	[CodeLanguage.Go]: "//",
	[CodeLanguage.Java]: "//",
	[CodeLanguage.SQL]: "--",
	[CodeLanguage.Python]: "#",
	[CodeLanguage.Shell]: "#",
	[CodeLanguage.YAML]: "#",
	[CodeLanguage.TOML]: "#",
	[CodeLanguage.Dockerfile]: "#",
};

export function lineCommentToken(language: CodeLanguage): string | null {
	return LINE_COMMENT_TOKENS[language] ?? null;
}

function splitLines(text: string): string[] {
	return text.split("\n");
}

/** Offset at which each line begins (line `i` starts at `starts[i]`). */
function lineStarts(lines: string[]): number[] {
	const starts = new Array<number>(lines.length);
	let acc = 0;
	for (let i = 0; i < lines.length; i++) {
		starts[i] = acc;
		acc += (lines[i] as string).length + 1;
	}
	return starts;
}

function lineAt(starts: number[], offset: number): number {
	let lo = 0;
	let hi = starts.length - 1;
	let ans = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if ((starts[mid] as number) <= offset) {
			ans = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return ans;
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

function selectedLineRange(starts: number[], selStart: number, selEnd: number): [number, number] {
	const a = Math.min(selStart, selEnd);
	const b = Math.max(selStart, selEnd);
	const first = lineAt(starts, a);
	let last = lineAt(starts, b);
	if (b > a && b === starts[last] && last > first) last -= 1;
	return [first, last];
}

export function moveLines(input: BufferSelection, direction: LineMoveDirection): BufferSelection {
	const { text, selStart, selEnd } = input;
	const lines = splitLines(text);
	const starts = lineStarts(lines);
	const [first, last] = selectedLineRange(starts, selStart, selEnd);

	if (direction === LineMoveDirection.Up) {
		if (first === 0) return input;
		const shift = (lines[first - 1] as string).length + 1;
		const reordered = [
			...lines.slice(0, first - 1),
			...lines.slice(first, last + 1),
			lines[first - 1] as string,
			...lines.slice(last + 1),
		];
		return { text: reordered.join("\n"), selStart: selStart - shift, selEnd: selEnd - shift };
	}

	if (last === lines.length - 1) return input;
	const shift = (lines[last + 1] as string).length + 1;
	const reordered = [
		...lines.slice(0, first),
		lines[last + 1] as string,
		...lines.slice(first, last + 1),
		...lines.slice(last + 2),
	];
	return { text: reordered.join("\n"), selStart: selStart + shift, selEnd: selEnd + shift };
}

export function duplicateLines(
	input: BufferSelection,
	direction: LineMoveDirection,
): BufferSelection {
	const { text, selStart, selEnd } = input;
	const lines = splitLines(text);
	const starts = lineStarts(lines);
	const [first, last] = selectedLineRange(starts, selStart, selEnd);
	const block = lines.slice(first, last + 1);

	if (direction === LineMoveDirection.Down) {
		const reordered = [...lines.slice(0, last + 1), ...block, ...lines.slice(last + 1)];
		const shift = block.join("\n").length + 1;
		return { text: reordered.join("\n"), selStart: selStart + shift, selEnd: selEnd + shift };
	}

	const reordered = [...lines.slice(0, first), ...block, ...lines.slice(first)];
	return { text: reordered.join("\n"), selStart, selEnd };
}

export function deleteLines(input: BufferSelection): BufferSelection {
	const { text, selStart, selEnd } = input;
	const lines = splitLines(text);
	const starts = lineStarts(lines);
	const [first, last] = selectedLineRange(starts, selStart, selEnd);

	const remaining = [...lines.slice(0, first), ...lines.slice(last + 1)];
	const next = remaining.length > 0 ? remaining : [""];
	const nextText = next.join("\n");
	const nextStarts = lineStarts(next);

	const caretLine = Math.min(first, next.length - 1);
	// Column basis is the selection anchor on the FIRST line — use the lower
	// offset so a reversed selection (selStart > selEnd) doesn't overshoot.
	const col = Math.min(selStart, selEnd) - (starts[first] as number);
	const lineLen = (next[caretLine] as string).length;
	const caret = (nextStarts[caretLine] as number) + clamp(col, 0, lineLen);
	const c = clamp(caret, 0, nextText.length);
	return { text: nextText, selStart: c, selEnd: c };
}

function leadingWhitespace(line: string): number {
	const m = /^[ \t]*/.exec(line);
	return m ? m[0].length : 0;
}

function isCommented(line: string, token: string): boolean {
	return line.slice(leadingWhitespace(line)).startsWith(token);
}

export function toggleLineComment(input: BufferSelection, token: string | null): BufferSelection {
	if (!token) return input;
	const { text, selStart, selEnd } = input;
	const lines = splitLines(text);
	const starts = lineStarts(lines);
	const [first, last] = selectedLineRange(starts, selStart, selEnd);

	const targets: number[] = [];
	for (let i = first; i <= last; i++) {
		if ((lines[i] as string).trim().length > 0) targets.push(i);
	}
	if (targets.length === 0) return input;

	const allCommented = targets.every((i) => isCommented(lines[i] as string, token));
	const newLines = lines.slice();
	let mapOffset: (offset: number) => number;

	if (allCommented) {
		const removed = new Map<number, { at: number; len: number }>();
		for (const i of targets) {
			const line = lines[i] as string;
			const ws = leadingWhitespace(line);
			let removeLen = token.length;
			if (line[ws + token.length] === " ") removeLen += 1;
			newLines[i] = line.slice(0, ws) + line.slice(ws + removeLen);
			removed.set(i, { at: ws, len: removeLen });
		}
		const nextStarts = lineStarts(newLines);
		mapOffset = (offset) => {
			const ln = lineAt(starts, offset);
			const col = offset - (starts[ln] as number);
			const r = removed.get(ln);
			let newCol = col;
			if (r) {
				if (col <= r.at) newCol = col;
				else if (col >= r.at + r.len) newCol = col - r.len;
				else newCol = r.at;
			}
			return (nextStarts[ln] as number) + newCol;
		};
	} else {
		const insertCol = Math.min(...targets.map((i) => leadingWhitespace(lines[i] as string)));
		const insert = `${token} `;
		for (const i of targets) {
			const line = lines[i] as string;
			newLines[i] = line.slice(0, insertCol) + insert + line.slice(insertCol);
		}
		const nextStarts = lineStarts(newLines);
		const targetSet = new Set(targets);
		mapOffset = (offset) => {
			const ln = lineAt(starts, offset);
			const col = offset - (starts[ln] as number);
			const newCol = targetSet.has(ln) && col > insertCol ? col + insert.length : col;
			return (nextStarts[ln] as number) + newCol;
		};
	}

	const nextText = newLines.join("\n");
	return {
		text: nextText,
		selStart: clamp(mapOffset(selStart), 0, nextText.length),
		selEnd: clamp(mapOffset(selEnd), 0, nextText.length),
	};
}
