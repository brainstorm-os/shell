import { RelativeDateRange } from "@brainstorm-os/sdk/predicate-eval";
import { describe, expect, it } from "vitest";
import { type Entity, FILE_TYPE, FOLDER_TYPE, NOTE_TYPE } from "../types/entity";
import {
	DEFAULT_FILE_FILTERS,
	KindFilter,
	SizeFilter,
	applyFileFilters,
	collectExtensions,
	countActiveFilters,
	hasActiveFilters,
	kindOf,
} from "./filters";

const NOW = new Date(2026, 9, 18, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

function file(id: string, name: string, mime: string, size: number, updatedAt = NOW): Entity {
	return {
		id,
		type: FILE_TYPE,
		properties: { name, mime, size },
		createdAt: updatedAt,
		updatedAt,
		deletedAt: null,
	};
}

function folder(id: string, name: string): Entity {
	return {
		id,
		type: FOLDER_TYPE,
		properties: { name, members: [] },
		createdAt: NOW,
		updatedAt: NOW,
		deletedAt: null,
	};
}

const photo = file("p", "beach.JPG", "image/jpeg", 3 * 1024 * 1024);
const report = file("r", "report.pdf", "application/pdf", 400 * 1024, NOW - 3 * DAY);
const notes = file("n", "notes.txt", "text/plain", 20, NOW - 40 * DAY);
const song = file("s", "song.mp3", "audio/mpeg", 50 * 1024 * 1024);
const backup = file("b", "backup.zip", "application/zip", 200 * 1024 * 1024);
const blob = file("x", "mystery", "application/octet-stream", 10);
const docs = folder("f", "Docs");
const rows = [photo, report, notes, song, backup, blob, docs];

describe("kindOf", () => {
	it("buckets files by MIME family", () => {
		expect(kindOf(photo)).toBe(KindFilter.Image);
		expect(kindOf(report)).toBe(KindFilter.Document);
		expect(kindOf(notes)).toBe(KindFilter.Document);
		expect(kindOf(song)).toBe(KindFilter.Audio);
		expect(kindOf(backup)).toBe(KindFilter.Archive);
		expect(kindOf(blob)).toBe(KindFilter.Other);
		expect(kindOf(docs)).toBe(KindFilter.Folder);
	});

	it("reads Notes as documents and other typed objects as Other", () => {
		expect(kindOf({ ...docs, type: NOTE_TYPE })).toBe(KindFilter.Document);
		expect(kindOf({ ...docs, type: "brainstorm/Person/v1" })).toBe(KindFilter.Other);
	});
});

describe("applyFileFilters", () => {
	it("is an identity copy when nothing is active", () => {
		const out = applyFileFilters(rows, DEFAULT_FILE_FILTERS, NOW);
		expect(out).toEqual(rows);
		expect(out).not.toBe(rows);
		expect(hasActiveFilters(DEFAULT_FILE_FILTERS)).toBe(false);
	});

	it("filters by kind", () => {
		const out = applyFileFilters(rows, { ...DEFAULT_FILE_FILTERS, kind: KindFilter.Document }, NOW);
		expect(out.map((e) => e.id)).toEqual(["r", "n"]);
	});

	it("filters by size band and drops sizeless rows (folders)", () => {
		const medium = applyFileFilters(rows, { ...DEFAULT_FILE_FILTERS, size: SizeFilter.Medium }, NOW);
		expect(medium.map((e) => e.id)).toEqual(["p"]);
		const tiny = applyFileFilters(rows, { ...DEFAULT_FILE_FILTERS, size: SizeFilter.Tiny }, NOW);
		expect(tiny.map((e) => e.id)).toEqual(["n", "x"]);
		const huge = applyFileFilters(rows, { ...DEFAULT_FILE_FILTERS, size: SizeFilter.Huge }, NOW);
		expect(huge.map((e) => e.id)).toEqual(["b"]);
	});

	it("filters by extension case-insensitively", () => {
		const out = applyFileFilters(rows, { ...DEFAULT_FILE_FILTERS, extension: "jpg" }, NOW);
		expect(out.map((e) => e.id)).toEqual(["p"]);
	});

	it("filters by a live-rolling modified range", () => {
		const week = applyFileFilters(
			rows,
			{ ...DEFAULT_FILE_FILTERS, modified: RelativeDateRange.Last7Days },
			NOW,
		);
		expect(week.map((e) => e.id)).not.toContain("n");
		expect(week.map((e) => e.id)).toContain("r");
		const today = applyFileFilters(
			rows,
			{ ...DEFAULT_FILE_FILTERS, modified: RelativeDateRange.Today },
			NOW,
		);
		expect(today.map((e) => e.id)).not.toContain("r");
	});

	it("ANDs every active axis", () => {
		const filters = {
			kind: KindFilter.Document,
			size: SizeFilter.Small,
			modified: RelativeDateRange.Last30Days,
			extension: "pdf",
		};
		expect(countActiveFilters(filters)).toBe(4);
		expect(applyFileFilters(rows, filters, NOW).map((e) => e.id)).toEqual(["r"]);
	});
});

describe("collectExtensions", () => {
	it("lists distinct lower-cased extensions A→Z, files only", () => {
		expect(collectExtensions(rows, null)).toEqual(["jpg", "mp3", "pdf", "txt", "zip"]);
	});

	it("keeps the selected extension listed even when no row has it", () => {
		expect(collectExtensions([photo], "pdf")).toEqual(["jpg", "pdf"]);
	});
});
