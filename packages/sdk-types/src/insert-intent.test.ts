import { describe, expect, it } from "vitest";
import {
	INSERT_INTENT_VERB,
	INSERT_MARKDOWN_MAX,
	InsertPosition,
	buildNoteInsertPayload,
	parseNoteInsertPayload,
} from "./insert-intent";

const NOTE_TYPE = "io.brainstorm.notes/Note/v1";

describe("buildNoteInsertPayload", () => {
	it("builds a well-formed end-position payload", () => {
		const payload = buildNoteInsertPayload({
			entityId: "note-1",
			entityType: NOTE_TYPE,
			markdown: "## Reply\n\nBody text.",
		});
		expect(payload).toEqual({
			entityId: "note-1",
			entityType: NOTE_TYPE,
			position: InsertPosition.End,
			markdown: "## Reply\n\nBody text.",
		});
	});

	it("trims the target identifiers", () => {
		const payload = buildNoteInsertPayload({
			entityId: " note-1 ",
			entityType: ` ${NOTE_TYPE} `,
			markdown: "x",
		});
		expect(payload.entityId).toBe("note-1");
		expect(payload.entityType).toBe(NOTE_TYPE);
	});

	it("throws on an empty target or empty markdown", () => {
		expect(() =>
			buildNoteInsertPayload({ entityId: "  ", entityType: NOTE_TYPE, markdown: "x" }),
		).toThrow(/entityId/);
		expect(() => buildNoteInsertPayload({ entityId: "n", entityType: "", markdown: "x" })).toThrow(
			/entityType/,
		);
		expect(() =>
			buildNoteInsertPayload({ entityId: "n", entityType: NOTE_TYPE, markdown: "   " }),
		).toThrow(/markdown/);
	});

	it("throws above the markdown bound", () => {
		expect(() =>
			buildNoteInsertPayload({
				entityId: "n",
				entityType: NOTE_TYPE,
				markdown: "a".repeat(INSERT_MARKDOWN_MAX + 1),
			}),
		).toThrow(/exceeds/);
	});
});

describe("parseNoteInsertPayload (fail-closed)", () => {
	const valid = () => ({
		entityId: "note-1",
		entityType: NOTE_TYPE,
		position: InsertPosition.End,
		markdown: "content",
	});

	it("round-trips a built payload", () => {
		const built = buildNoteInsertPayload({
			entityId: "note-1",
			entityType: NOTE_TYPE,
			markdown: "content",
		});
		expect(parseNoteInsertPayload(built)).toEqual(built);
	});

	it("refuses non-object shapes", () => {
		expect(parseNoteInsertPayload(null)).toBeNull();
		expect(parseNoteInsertPayload("insert")).toBeNull();
		expect(parseNoteInsertPayload([valid()])).toBeNull();
	});

	it("refuses a missing / blank / non-string field", () => {
		expect(parseNoteInsertPayload({ ...valid(), entityId: "" })).toBeNull();
		expect(parseNoteInsertPayload({ ...valid(), entityType: 7 })).toBeNull();
		expect(parseNoteInsertPayload({ ...valid(), markdown: "   " })).toBeNull();
		const { markdown: _dropped, ...withoutMarkdown } = valid();
		expect(parseNoteInsertPayload(withoutMarkdown)).toBeNull();
	});

	it("refuses any position other than end (v1 is append-only)", () => {
		expect(parseNoteInsertPayload({ ...valid(), position: "start" })).toBeNull();
		expect(parseNoteInsertPayload({ ...valid(), position: undefined })).toBeNull();
	});

	it("refuses oversized markdown", () => {
		expect(
			parseNoteInsertPayload({ ...valid(), markdown: "a".repeat(INSERT_MARKDOWN_MAX + 1) }),
		).toBeNull();
	});

	it("pins the expected entity type when given (mis-routed payload refused)", () => {
		expect(parseNoteInsertPayload(valid(), NOTE_TYPE)).not.toBeNull();
		expect(parseNoteInsertPayload(valid(), "io.brainstorm.tasks/Task/v1")).toBeNull();
	});

	it("verb literal matches the contributed-actions insert verb", () => {
		expect(INSERT_INTENT_VERB).toBe("insert");
	});
});
