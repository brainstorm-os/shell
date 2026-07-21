/**
 * Notes codec — `cover` persistence (B7.3). The note's OWN cover rides
 * the same persisted-blob ⇄ `StoredNote` seam as `icon`: `serializeNote`
 * is identity (so `noteToProps` carries `properties.cover` to the
 * entities service) and `parseStoredNote` reads it back through the SDK
 * `parseCover` validator. Legacy notes (no `cover`) must decode to
 * `null` so the renderer falls back to the id-seeded gradient.
 */

import { CoverKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { parseStoredNote, serializeNote } from "./codec";

const base = { id: "n_1", title: "Doc", body: "", values: {}, createdAt: 1, updatedAt: 2 };

describe("codec cover round-trip", () => {
	it("reads a valid Gradient / Image (with clamped focal) / Color cover", () => {
		expect(
			parseStoredNote({ ...base, cover: { kind: CoverKind.Gradient, value: "coral" } })?.cover,
		).toEqual({ kind: CoverKind.Gradient, value: "coral" });

		const img = parseStoredNote({
			...base,
			cover: { kind: CoverKind.Image, value: "brainstorm://cover/a.png", focal: { x: 9, y: -1 } },
		})?.cover;
		expect(img).toEqual({
			kind: CoverKind.Image,
			value: "brainstorm://cover/a.png",
			focal: { x: 1, y: 0 },
		});

		expect(
			parseStoredNote({ ...base, cover: { kind: CoverKind.Color, value: "--color-accent" } })?.cover,
		).toEqual({ kind: CoverKind.Color, value: "--color-accent" });
	});

	it("decodes a legacy / invalid cover to null (→ seeded-gradient fallback)", () => {
		expect(parseStoredNote(base)?.cover).toBeNull();
		expect(parseStoredNote({ ...base, cover: null })?.cover).toBeNull();
		expect(parseStoredNote({ ...base, cover: "coral" })?.cover).toBeNull();
		expect(parseStoredNote({ ...base, cover: { kind: "bogus", value: "x" } })?.cover).toBeNull();
	});

	it("serializeNote is identity, so the cover flows to properties.cover", () => {
		const note = parseStoredNote({ ...base, cover: { kind: CoverKind.Gradient, value: "sage" } });
		if (!note) throw new Error("expected a note");
		expect(serializeNote(note).cover).toEqual({ kind: CoverKind.Gradient, value: "sage" });
	});
});

describe("codec locked round-trip (synced page lock)", () => {
	it("reads `locked: true` back and carries it to properties via the identity serialize", () => {
		const note = parseStoredNote({ ...base, locked: true });
		expect(note?.locked).toBe(true);
		if (!note) throw new Error("expected a note");
		expect(serializeNote(note).locked).toBe(true);
	});

	it("treats a missing / falsey / non-boolean lock as unlocked (field omitted)", () => {
		expect(parseStoredNote(base)?.locked).toBeUndefined();
		expect(parseStoredNote({ ...base, locked: false })?.locked).toBeUndefined();
		expect(parseStoredNote({ ...base, locked: "true" })?.locked).toBeUndefined();
	});
});

describe("codec body↔bodyLegacy conflict resolution", () => {
	it("warns and drops the on-disk legacy `body` when `bodyLegacy` is already present (rollback target wins)", () => {
		const onDiskLegacy = { root: { type: "root", children: [], direction: "ltr" } };
		const existingRollback = {
			root: { type: "root", children: [{ type: "paragraph", children: [] }] },
		};
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const note = parseStoredNote({ ...base, body: onDiskLegacy, bodyLegacy: existingRollback });
			expect(note).not.toBeNull();
			expect(note?.body).toBe("");
			expect(note?.bodyLegacy).toEqual(existingRollback);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain("[notes/codec]");
		} finally {
			warn.mockRestore();
		}
	});

	it("promotes the on-disk legacy `body` to `bodyLegacy` when no rollback target exists (no warn)", () => {
		const onDiskLegacy = { root: { type: "root", children: [], direction: "ltr" } };
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const note = parseStoredNote({ ...base, body: onDiskLegacy });
			expect(note?.body).toBe("");
			expect(note?.bodyLegacy).toEqual(onDiskLegacy);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});
