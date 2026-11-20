import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Entity, FILE_TYPE } from "../types/entity";
import { formatTimeAgo, typeLabel } from "./entity-view";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 20, 12);

function file(properties: Record<string, unknown>): Entity {
	return { id: "f", type: FILE_TYPE, properties, createdAt: 1, updatedAt: 1, deletedAt: null };
}

describe("typeLabel — the Kind cell of a file", () => {
	it("shows the mime subtype when it names a real format", () => {
		expect(typeLabel(file({ name: "a.pdf", mime: "application/pdf" }))).toBe("pdf");
		expect(typeLabel(file({ name: "a.png", mime: "image/png" }))).toBe("png");
	});

	it("never prints the generic binary subtype — the extension names the kind instead", () => {
		for (const mime of [
			"application/octet-stream",
			"binary/octet-stream",
			"APPLICATION/Octet-Stream",
		]) {
			expect(typeLabel(file({ name: "book.fb2.epub", mime })), mime).toBe("EPUB");
		}
	});

	it("falls back to the localised generic File when there is no usable extension", () => {
		expect(typeLabel(file({ name: "mystery", mime: "application/octet-stream" }))).toBe("File");
		expect(typeLabel(file({ name: ".hidden", mime: "application/octet-stream" }))).toBe("File");
		expect(typeLabel(file({ name: "a.with space", mime: "application/octet-stream" }))).toBe("File");
	});

	it("uses the extension for a file with no mime at all, then File", () => {
		expect(typeLabel(file({ name: "notes.txt" }))).toBe("TXT");
		expect(typeLabel(file({ name: "notes", mime: "" }))).toBe("File");
	});
});

describe("formatTimeAgo — the Modified cell", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("anchors today and yesterday", () => {
		expect(formatTimeAgo(NOW - 1000)).toBe("Today");
		expect(formatTimeAgo(NOW - DAY - 1000)).toBe("Yesterday");
	});

	it("counts days inside the first week", () => {
		expect(formatTimeAgo(NOW - 3 * DAY)).toBe("3 days ago");
	});

	it("pluralises weeks — one week is not '1 wks ago'", () => {
		expect(formatTimeAgo(NOW - 8 * DAY)).toBe("1 week ago");
		expect(formatTimeAgo(NOW - 15 * DAY)).toBe("2 weeks ago");
		expect(formatTimeAgo(NOW - 59 * DAY)).toBe("8 weeks ago");
	});

	it("is empty for a row with no timestamp", () => {
		expect(formatTimeAgo(0)).toBe("");
	});
});
