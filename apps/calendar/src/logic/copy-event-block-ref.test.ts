// @vitest-environment jsdom
import { parseBrainstormEntityUri } from "@brainstorm-os/sdk/note-references";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyEventBlockRef, eventBlockRef } from "./copy-event-block-ref";

const EVENT_ID = "evt-42";

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

describe("eventBlockRef", () => {
	it("mints a plain brainstorm entity URI (no block fragment) the embed path resolves", () => {
		const ref = eventBlockRef(EVENT_ID);
		expect(ref).toBe("brainstorm://entity/evt-42");
		// The document host's embed/link path parses this exact grammar to
		// look up the Event type's live block (the inline-event bundle).
		const parsed = parseBrainstormEntityUri(ref);
		expect(parsed?.entityId).toBe(EVENT_ID);
		expect(parsed?.blockId).toBeUndefined();
	});
});

describe("copyEventBlockRef", () => {
	it("writes the event's block ref to the clipboard and reports success", async () => {
		const writeText = vi.fn(async () => {});
		stubClipboard(writeText);
		const ok = await copyEventBlockRef(EVENT_ID);
		expect(ok).toBe(true);
		expect(writeText).toHaveBeenCalledWith("brainstorm://entity/evt-42");
	});

	it("is a fail-closed no-op when the Clipboard API is absent", async () => {
		// clipboard left undefined by the afterEach reset.
		expect(await copyEventBlockRef(EVENT_ID)).toBe(false);
	});

	it("swallows a denied clipboard write instead of throwing", async () => {
		stubClipboard(async () => {
			throw new Error("denied");
		});
		expect(await copyEventBlockRef(EVENT_ID)).toBe(false);
	});
});
