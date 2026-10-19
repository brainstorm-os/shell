import type { SerializedEditorState } from "lexical";
import { describe, expect, it, vi } from "vitest";
import { CaptureOutcome, CapturePartKind } from "./capture-filing";
import { captureIntoDay } from "./capture-into-day";

const WELCOME_ID = "welcome-journal-day-one";
const STATE = {
	root: { children: [], direction: null, format: "", indent: 0, type: "root", version: 1 },
} as unknown as SerializedEditorState;

describe("captureIntoDay", () => {
	it("appends to the entry the day resolves to and mirrors the body under that id", async () => {
		const append = vi.fn(() => STATE);
		const denormalize = vi.fn();
		const result = await captureIntoDay({
			raw: "Walked the harbour",
			collections: [],
			writer: null,
			ensureEntry: async () => WELCOME_ID,
			append,
			denormalize,
		});
		expect(result).toEqual({ outcome: CaptureOutcome.Appended, collectionName: null });
		expect(append).toHaveBeenCalledWith(WELCOME_ID, [
			{ kind: CapturePartKind.Text, text: "Walked the harbour" },
		]);
		expect(denormalize).toHaveBeenCalledWith(WELCOME_ID, STATE);
	});

	it("is unavailable when the live editor is not on the resolved entry — nothing is mirrored", async () => {
		const append = vi.fn(() => null);
		const denormalize = vi.fn();
		const result = await captureIntoDay({
			raw: "Walked the harbour",
			collections: [],
			writer: null,
			ensureEntry: async () => WELCOME_ID,
			append,
			denormalize,
		});
		expect(result.outcome).toBe(CaptureOutcome.Unavailable);
		expect(append).toHaveBeenCalledWith(WELCOME_ID, expect.anything());
		expect(denormalize).not.toHaveBeenCalled();
	});

	it("is unavailable when the day could not be resolved, without touching the editor", async () => {
		const append = vi.fn(() => STATE);
		const result = await captureIntoDay({
			raw: "Walked the harbour",
			collections: [],
			writer: null,
			ensureEntry: async () => null,
			append,
			denormalize: vi.fn(),
		});
		expect(result.outcome).toBe(CaptureOutcome.Unavailable);
		expect(append).not.toHaveBeenCalled();
	});

	it("ignores a blank line before resolving the day", async () => {
		const ensureEntry = vi.fn(async () => WELCOME_ID);
		const result = await captureIntoDay({
			raw: "   ",
			collections: [],
			writer: null,
			ensureEntry,
			append: vi.fn(() => STATE),
			denormalize: vi.fn(),
		});
		expect(result.outcome).toBe(CaptureOutcome.Ignored);
		expect(ensureEntry).not.toHaveBeenCalled();
	});
});
