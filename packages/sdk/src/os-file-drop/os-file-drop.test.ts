// @vitest-environment jsdom
import type { FileImportResult } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { ENTITY_DRAG_MIME } from "../entity-drag";
import {
	FILE_ENTITY_TYPE,
	OsFileDragTracker,
	bindOsFileDrop,
	fileEntityProperties,
	importDroppedOsFiles,
	importOsFilesAsEntities,
	isOsFileDrag,
} from "./index";

function dropped(name: string, text: string) {
	return { name, arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer };
}

function importer(fail: readonly string[] = []) {
	return {
		import: vi.fn(async (input: { name: string; bytes: Uint8Array | ArrayBuffer }) => {
			if (fail.includes(input.name)) throw new Error("import failed");
			const size = input.bytes.byteLength;
			return {
				assetId: `asset-${input.name}`,
				contentHash: `hash-${size}`,
				size,
				mime: "application/octet-stream",
				name: input.name,
			} satisfies FileImportResult;
		}),
	};
}

describe("isOsFileDrag", () => {
	it("accepts a plain OS file drag", () => {
		expect(isOsFileDrag({ types: ["Files"] })).toBe(true);
	});

	it("rejects drags without files, in-app object drags, and ignored MIMEs", () => {
		expect(isOsFileDrag({ types: ["text/plain"] })).toBe(false);
		expect(isOsFileDrag({ types: ["Files", ENTITY_DRAG_MIME] })).toBe(false);
		expect(isOsFileDrag({ types: ["Files", "application/x-mine"] }, ["application/x-mine"])).toBe(
			false,
		);
		expect(isOsFileDrag(null)).toBe(false);
	});
});

describe("OsFileDragTracker", () => {
	it("stays over across nested enter/leave and resets on drop", () => {
		const changes: boolean[] = [];
		const tracker = new OsFileDragTracker((over) => changes.push(over));
		tracker.enter();
		tracker.enter();
		tracker.leave();
		expect(tracker.over).toBe(true);
		tracker.leave();
		tracker.leave();
		expect(tracker.over).toBe(false);
		tracker.enter();
		tracker.reset();
		expect(changes).toEqual([true, false, true, false]);
	});
});

describe("importDroppedOsFiles", () => {
	it("stores each file and answers File/v1-ready metadata with an extension-truthful mime", async () => {
		const svc = importer();
		const out = await importDroppedOsFiles([dropped("a.png", "abc"), dropped("b.txt", "hello")], svc);
		expect(out).toEqual([
			{
				name: "a.png",
				mime: "image/png",
				size: 3,
				hash: "hash-3",
				assetId: "asset-a.png",
				assetMime: "application/octet-stream",
			},
			expect.objectContaining({ name: "b.txt", mime: "text/plain", size: 5 }),
		]);
	});

	it("skips a failing file and reports it without aborting the batch", async () => {
		const onError = vi.fn();
		const out = await importDroppedOsFiles(
			[dropped("bad.bin", "x"), dropped("good.md", "y")],
			importer(["bad.bin"]),
			{ onError },
		);
		expect(out.map((f) => f.name)).toEqual(["good.md"]);
		expect(onError).toHaveBeenCalledOnce();
		expect(onError.mock.calls[0]?.[0]?.name).toBe("bad.bin");
	});
});

describe("importOsFilesAsEntities", () => {
	it("creates one File/v1 per stored file and returns the ids", async () => {
		const create = vi.fn(async (_type: string, props: Record<string, unknown>) => ({
			id: `ent-${String(props.name)}`,
		}));
		const out = await importOsFilesAsEntities([dropped("c.pdf", "pdf!")], {
			files: importer(),
			entities: { create },
		});
		expect(out.map((c) => c.id)).toEqual(["ent-c.pdf"]);
		expect(create).toHaveBeenCalledWith(FILE_ENTITY_TYPE, {
			name: "c.pdf",
			mime: "application/pdf",
			size: 4,
			hash: "hash-4",
			assetId: "asset-c.pdf",
			assetMime: "application/octet-stream",
		});
	});

	it("reports a failed create against its source file", async () => {
		const onError = vi.fn();
		const out = await importOsFilesAsEntities(
			[dropped("d.txt", "z")],
			{ files: importer(), entities: { create: vi.fn().mockRejectedValue(new Error("denied")) } },
			{ onError },
		);
		expect(out).toEqual([]);
		expect(onError.mock.calls[0]?.[0]?.name).toBe("d.txt");
	});
});

describe("fileEntityProperties", () => {
	it("lets the caller override the display name", () => {
		const props = fileEntityProperties(
			{ name: "a.png", mime: "image/png", size: 1, hash: "h", assetId: "a", assetMime: "image/png" },
			"a (2).png",
		);
		expect(props.name).toBe("a (2).png");
	});
});

describe("bindOsFileDrop", () => {
	function dragEvent(type: string, types: string[], files: File[] = []): Event {
		const event = new Event(type, { bubbles: true, cancelable: true });
		Object.defineProperty(event, "dataTransfer", {
			value: { types, files, dropEffect: "none" },
		});
		return event;
	}

	it("lights the zone during an OS file drag and hands over dropped files", () => {
		const el = document.createElement("div");
		const onFiles = vi.fn();
		const unbind = bindOsFileDrop(el, { onFiles });
		el.dispatchEvent(dragEvent("dragenter", ["Files"]));
		expect(el.dataset.osDrop).toBe("true");
		const file = new File(["x"], "x.txt");
		const drop = dragEvent("drop", ["Files"], [file]);
		el.dispatchEvent(drop);
		expect(drop.defaultPrevented).toBe(true);
		expect(el.dataset.osDrop).toBe("false");
		expect(onFiles).toHaveBeenCalledWith([file]);
		unbind();
		expect(el.dataset.osDrop).toBeUndefined();
	});

	it("ignores in-app object drags and respects the enabled gate", () => {
		const el = document.createElement("div");
		const onFiles = vi.fn();
		let enabled = true;
		bindOsFileDrop(el, { onFiles, enabled: () => enabled });
		el.dispatchEvent(dragEvent("drop", ["Files", ENTITY_DRAG_MIME], [new File(["a"], "a")]));
		enabled = false;
		el.dispatchEvent(dragEvent("drop", ["Files"], [new File(["b"], "b")]));
		expect(onFiles).not.toHaveBeenCalled();
	});
});
