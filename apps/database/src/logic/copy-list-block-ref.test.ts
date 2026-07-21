// @vitest-environment jsdom
import { parseBrainstormEntityUri } from "@brainstorm-os/sdk/note-references";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyListBlockRef, listBlockRef } from "./copy-list-block-ref";

const LIST_ID = "list-42";

afterEach(() => {
	vi.restoreAllMocks();
	Object.defineProperty(globalThis.navigator, "clipboard", {
		value: undefined,
		configurable: true,
	});
});

function stubClipboard(writeText: (text: string) => Promise<void>): void {
	Object.defineProperty(globalThis.navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
}

describe("listBlockRef", () => {
	it("mints a plain brainstorm entity URI (no block fragment) the embed path resolves", () => {
		const ref = listBlockRef(LIST_ID);
		expect(ref).toBe("brainstorm://entity/list-42");
		// The document host's embed/link path parses this exact grammar to look
		// up the List type's live block (the embedded-list bundle this app
		// provides) and mount it inline.
		const parsed = parseBrainstormEntityUri(ref);
		expect(parsed?.entityId).toBe(LIST_ID);
		expect(parsed?.blockId).toBeUndefined();
	});
});

describe("copyListBlockRef", () => {
	it("writes the list's block ref to the clipboard and reports success", async () => {
		const writeText = vi.fn(async () => {});
		stubClipboard(writeText);
		const ok = await copyListBlockRef(LIST_ID);
		expect(ok).toBe(true);
		expect(writeText).toHaveBeenCalledWith("brainstorm://entity/list-42");
	});

	it("is a fail-closed no-op when the Clipboard API is absent", async () => {
		// clipboard left undefined by the afterEach reset.
		expect(await copyListBlockRef(LIST_ID)).toBe(false);
	});

	it("swallows a denied clipboard write instead of throwing", async () => {
		stubClipboard(async () => {
			throw new Error("denied");
		});
		expect(await copyListBlockRef(LIST_ID)).toBe(false);
	});
});
