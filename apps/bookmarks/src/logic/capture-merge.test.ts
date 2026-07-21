import type { SerializedBlock } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { capturedBlocksToApply } from "./capture-merge";

const block = (text: string): SerializedBlock =>
	({ type: "paragraph", children: [{ type: "text", text }] }) as unknown as SerializedBlock;

describe("capturedBlocksToApply", () => {
	it("applies a non-empty fetched body", () => {
		const blocks = [block("First"), block("Second")];
		expect(capturedBlocksToApply(blocks)).toBe(blocks);
	});

	it("keeps the stored body when extraction yielded nothing (null)", () => {
		// Regression: "Reload from source" on a page that no longer extracts
		// (SPA / paywall / worker hiccup) must not wipe the captured content.
		expect(capturedBlocksToApply(null)).toBeNull();
	});

	it("keeps the stored body when extraction yielded an empty array", () => {
		expect(capturedBlocksToApply([])).toBeNull();
	});

	it("treats undefined like a no-content result", () => {
		expect(capturedBlocksToApply(undefined)).toBeNull();
	});
});
