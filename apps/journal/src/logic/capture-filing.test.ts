// @vitest-environment jsdom
/**
 * 9.16.14 — quick-capture filing: which collections a capture can file into
 * (the shared `decideRowCreate` member type must be writable by Journal), and
 * the write sequence for a line vs a filed object (create → link from the
 * day → join the collection's manual members), with every failure keeping
 * the user's words in the day.
 */
import { MentionNode } from "@brainstorm-os/editor";
import { $createParagraphNode, $getRoot, createEditor } from "lexical";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendJournalLine, clearJournalEditor, setJournalEditor } from "../ui/editor-bridge";
import {
	CaptureOutcome,
	CapturePartKind,
	type CaptureWriter,
	type FileableCollection,
	commitCapture,
	fileableCollections,
} from "./capture-filing";

const CAPS = [
	"entities.write:brainstorm/List/v1",
	"entities.write:brainstorm/Object/v1",
	"entities.write:io.brainstorm.journal/Entry/v1",
];

function list(id: string, name: string, source: unknown = null, deletedAt: number | null = null) {
	return {
		id,
		type: "brainstorm/List/v1",
		properties: { name, source, members: { include: [], exclude: [] } },
		createdAt: 0,
		updatedAt: 0,
		deletedAt,
	};
}

const READING: FileableCollection = {
	id: "list-reading",
	name: "Reading list",
	memberType: "brainstorm/Object/v1",
	pinMember: true,
};

describe("fileableCollections", () => {
	it("offers live manual collections (generic Object members), A→Z", () => {
		const out = fileableCollections(
			[list("b", "Watch later"), list("a", "Reading list"), list("gone", "Old", null, 5)],
			CAPS,
		);
		expect(out.map((c) => c.name)).toEqual(["Reading list", "Watch later"]);
		expect(out[0]).toMatchObject({ memberType: "brainstorm/Object/v1", pinMember: true });
	});

	it("skips a typed collection whose member type Journal cannot write", () => {
		const tasks = list("t", "Sprint", { kind: "byType", types: ["brainstorm/Task/v1"] });
		expect(fileableCollections([tasks], CAPS)).toEqual([]);
		expect(fileableCollections([tasks], [...CAPS, "entities.write:brainstorm/Task/v1"])).toEqual([
			expect.objectContaining({ id: "t", memberType: "brainstorm/Task/v1", pinMember: false }),
		]);
	});

	it("skips a locked collection (read-only lists take no new members)", () => {
		const locked = list("l", "Archive");
		locked.properties = { ...locked.properties, locked: true } as typeof locked.properties;
		expect(fileableCollections([locked, list("a", "Reading list")], CAPS).map((c) => c.id)).toEqual([
			"a",
		]);
	});

	it("offers nothing without the List write grant", () => {
		expect(
			fileableCollections([list("a", "Reading list")], ["entities.write:brainstorm/Object/v1"]),
		).toEqual([]);
	});
});

function writer(over: Partial<CaptureWriter> = {}) {
	const listRow = list("list-reading", "Reading list");
	const create = vi.fn(async () => ({ id: "obj-1" }));
	const update = vi.fn(async () => ({}));
	const get = vi.fn(async () => listRow);
	return {
		create,
		update,
		get,
		writer: {
			create,
			membership: { get, update },
			appId: "io.brainstorm.journal",
			now: 42,
			...over,
		} satisfies CaptureWriter,
	};
}

describe("commitCapture", () => {
	it("appends an untagged line and writes nothing else", async () => {
		const w = writer();
		const append = vi.fn(() => true);
		const result = await commitCapture({
			raw: "call the plumber",
			collections: [READING],
			writer: w.writer,
			canAppend: () => true,
			append,
		});
		expect(result.outcome).toBe(CaptureOutcome.Appended);
		expect(append).toHaveBeenCalledWith([{ kind: CapturePartKind.Text, text: "call the plumber" }]);
		expect(w.create).not.toHaveBeenCalled();
	});

	it("files a tagged line: creates the object, links it from the day, joins the collection", async () => {
		const w = writer();
		const append = vi.fn(() => true);
		const result = await commitCapture({
			raw: "Piranesi #reading-list",
			collections: [READING],
			writer: w.writer,
			canAppend: () => true,
			append,
		});
		expect(result.outcome).toBe(CaptureOutcome.Filed);
		expect(w.create).toHaveBeenCalledWith("brainstorm/Object/v1", {
			name: "Piranesi",
			createdAt: 42,
			updatedAt: 42,
		});
		expect(append).toHaveBeenCalledWith([
			{
				kind: CapturePartKind.Mention,
				entityId: "obj-1",
				entityType: "brainstorm/Object/v1",
				label: "Piranesi",
			},
			{ kind: CapturePartKind.Text, text: " #reading-list" },
		]);
		expect(w.update).toHaveBeenCalledWith("list-reading", {
			members: {
				include: [expect.objectContaining({ entityId: "obj-1", by: "app:io.brainstorm.journal" })],
				exclude: [],
			},
		});
	});

	it("keeps the line (tag and all) when the create fails", async () => {
		const w = writer({ create: vi.fn().mockRejectedValue(new Error("denied")) });
		const append = vi.fn(() => true);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = await commitCapture({
			raw: "Piranesi #reading-list",
			collections: [READING],
			writer: w.writer,
			canAppend: () => true,
			append,
		});
		warn.mockRestore();
		expect(result.outcome).toBe(CaptureOutcome.FileFailed);
		expect(append).toHaveBeenCalledWith([
			{ kind: CapturePartKind.Text, text: "Piranesi #reading-list" },
		]);
	});

	it("reports a created-but-not-joined object when the collection vanished", async () => {
		const w = writer();
		w.get.mockResolvedValue(null as never);
		const result = await commitCapture({
			raw: "Piranesi #reading-list",
			collections: [READING],
			writer: w.writer,
			canAppend: () => true,
			append: () => true,
		});
		expect(result.outcome).toBe(CaptureOutcome.FiledWithoutMembership);
	});

	it("writes nothing when there is no editor to append into", async () => {
		const w = writer();
		const result = await commitCapture({
			raw: "Piranesi #reading-list",
			collections: [READING],
			writer: w.writer,
			canAppend: () => false,
			append: () => true,
		});
		expect(result.outcome).toBe(CaptureOutcome.Unavailable);
		expect(w.create).not.toHaveBeenCalled();
	});
});

const DAY_ID = "journal-2026-10-19";

describe("appendJournalLine", () => {
	let editor: ReturnType<typeof createEditor> | null = null;
	afterEach(() => {
		if (editor) clearJournalEditor(editor);
		editor = null;
	});

	it("is a no-op without a mounted editor", () => {
		expect(appendJournalLine(DAY_ID, [{ kind: CapturePartKind.Text, text: "x" }])).toBeNull();
	});

	it("appends a paragraph at the end, reusing a fresh day's lone empty paragraph", () => {
		editor = createEditor({
			nodes: [MentionNode],
			onError: (e) => {
				throw e;
			},
		});
		setJournalEditor(editor, DAY_ID);
		editor.update(() => $getRoot().append($createParagraphNode()), { discrete: true });
		const first = appendJournalLine(DAY_ID, [{ kind: CapturePartKind.Text, text: "first" }]);
		expect(first?.root.children).toHaveLength(1);
		const second = appendJournalLine(DAY_ID, [
			{
				kind: CapturePartKind.Mention,
				entityId: "obj-1",
				entityType: "brainstorm/Object/v1",
				label: "Piranesi",
			},
			{ kind: CapturePartKind.Text, text: " #reading-list" },
		]);
		expect(second?.root.children).toHaveLength(2);
		const text = editor.getEditorState().read(() => $getRoot().getTextContent());
		expect(text).toContain("first");
		expect(text).toContain("#reading-list");
	});
});
