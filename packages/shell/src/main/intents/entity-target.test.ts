import { describe, expect, it } from "vitest";
import type { EntitiesRepository, EntityRow } from "../storage/entities-repo";
import {
	makeEntityTargetResolver,
	mimeFromProperties,
	routingMimeFromProperties,
} from "./entity-target";

function fakeRepo(get: (id: string) => EntityRow | null): EntitiesRepository {
	return { get } as unknown as EntitiesRepository;
}

function row(over: Partial<EntityRow>): EntityRow {
	return {
		id: "ent_1",
		type: "io.example/Note/v1",
		spaceId: null,
		properties: {},
		createdBy: "u",
		createdAt: 0,
		updatedAt: 0,
		...over,
	};
}

describe("mimeFromProperties", () => {
	it("reads `mime` first", () => {
		expect(mimeFromProperties({ mime: "image/png", mimeType: "text/plain" })).toBe("image/png");
	});
	it("falls back to `mimeType`", () => {
		expect(mimeFromProperties({ mimeType: "application/pdf" })).toBe("application/pdf");
	});
	it("ignores empty / non-string values", () => {
		expect(mimeFromProperties({ mime: "", mimeType: 42 })).toBeUndefined();
		expect(mimeFromProperties({})).toBeUndefined();
	});
});

describe("routingMimeFromProperties", () => {
	const GENERIC = "application/octet-stream";

	it("keeps a specific stored MIME, whatever the name says", () => {
		expect(routingMimeFromProperties({ mime: "application/pdf", name: "x.epub" })).toBe(
			"application/pdf",
		);
	});

	it("routes a generically-labelled book file by its final extension", () => {
		const name = "King_Chetyre-posle-polunochi_3_Bibliotechnaya-policiya.159046.fb2.epub";
		expect(routingMimeFromProperties({ mime: GENERIC, name })).toBe("application/epub+zip");
		expect(routingMimeFromProperties({ mime: GENERIC, name: "Book.FB2" })).toBe(
			"application/x-fictionbook+xml",
		);
		expect(routingMimeFromProperties({ mime: "application/zip", name: "Book.fb2.zip" })).toBe(
			"application/x-zip-compressed-fb2",
		);
	});

	it("leaves a generic file that is not a book generic", () => {
		expect(routingMimeFromProperties({ mime: GENERIC, name: "blob.bin" })).toBe(GENERIC);
		expect(routingMimeFromProperties({ mime: "application/zip", name: "photos.zip" })).toBe(
			"application/zip",
		);
	});

	it("never invents a MIME for an entity that stores none", () => {
		expect(routingMimeFromProperties({ name: "draft.epub" })).toBeUndefined();
	});
});

describe("makeEntityTargetResolver", () => {
	it("resolves an EPUB stored as a generic binary to the EPUB MIME", async () => {
		const resolve = makeEntityTargetResolver(async () =>
			fakeRepo(() =>
				row({
					type: "brainstorm/File/v1",
					properties: { mime: "application/octet-stream", name: "Dune.fb2.epub" },
				}),
			),
		);
		expect(await resolve("ent_1")).toEqual({
			type: "brainstorm/File/v1",
			mime: "application/epub+zip",
		});
	});

	it("returns null when no vault session is open", async () => {
		const resolve = makeEntityTargetResolver(async () => null);
		expect(await resolve("ent_1")).toBeNull();
	});

	it("returns null for an unknown / soft-deleted id", async () => {
		const resolve = makeEntityTargetResolver(async () => fakeRepo(() => null));
		expect(await resolve("ent_missing")).toBeNull();
	});

	it("returns the bare type when the entity has no MIME", async () => {
		const resolve = makeEntityTargetResolver(async () =>
			fakeRepo(() => row({ type: "io.brainstorm.notes/Note/v1" })),
		);
		expect(await resolve("ent_1")).toEqual({ type: "io.brainstorm.notes/Note/v1" });
	});

	it("includes the MIME for a file-shaped entity", async () => {
		const resolve = makeEntityTargetResolver(async () =>
			fakeRepo(() => row({ type: "io.brainstorm.files/File/v1", properties: { mime: "image/png" } })),
		);
		expect(await resolve("ent_1")).toEqual({
			type: "io.brainstorm.files/File/v1",
			mime: "image/png",
		});
	});

	it("never throws — a repo failure resolves to null", async () => {
		const resolve = makeEntityTargetResolver(async () =>
			fakeRepo(() => {
				throw new Error("db closed mid-switch");
			}),
		);
		expect(await resolve("ent_1")).toBeNull();
	});
});
