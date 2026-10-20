// @vitest-environment jsdom
/**
 * `SpellcheckDictionaryPanel` (B11.17b) — lists the vault's custom words with
 * per-row remove, reading through the stubbed `window.brainstorm.spellcheck`
 * dashboard bridge. Real-DOM render so the boot `useEffect` + its async list /
 * languages calls flush.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpellcheckDictionaryPanel } from "./spellcheck-dictionary-panel";

type Stub = {
	listWords: ReturnType<typeof vi.fn>;
	removeWord: ReturnType<typeof vi.fn>;
	languages: ReturnType<typeof vi.fn>;
	setLanguages: ReturnType<typeof vi.fn>;
};

let stub: Stub;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	stub = {
		listWords: vi.fn().mockResolvedValue(["Brainstorm", "Yjs"]),
		removeWord: vi.fn().mockResolvedValue(["Yjs"]),
		languages: vi
			.fn()
			.mockResolvedValue({ active: ["en-US"], available: ["en-US", "de"], chosen: null }),
		setLanguages: vi
			.fn()
			.mockResolvedValue({ active: ["en-US"], available: ["en-US", "de"], chosen: null }),
	};
	(globalThis as { window?: unknown }).window = globalThis.window ?? {};
	(window as unknown as { brainstorm: { spellcheck: Stub } }).brainstorm = { spellcheck: stub };
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe("SpellcheckDictionaryPanel", () => {
	it("renders the vault's custom words after boot", async () => {
		await act(async () => {
			root.render(<SpellcheckDictionaryPanel />);
		});
		expect(stub.listWords).toHaveBeenCalled();
		expect(host.textContent).toContain("Brainstorm");
		expect(host.textContent).toContain("Yjs");
	});

	it("removes a word through the bridge and re-renders the returned list", async () => {
		await act(async () => {
			root.render(<SpellcheckDictionaryPanel />);
		});
		const removeBtn = host.querySelector<HTMLButtonElement>('button[aria-label*="Brainstorm"]');
		expect(removeBtn).not.toBeNull();
		await act(async () => {
			removeBtn?.click();
		});
		expect(stub.removeWord).toHaveBeenCalledWith("Brainstorm");
		expect(host.textContent).not.toContain("Brainstorm");
		expect(host.textContent).toContain("Yjs");
	});

	it("shows the empty hint when there are no words", async () => {
		stub.listWords.mockResolvedValue([]);
		await act(async () => {
			root.render(<SpellcheckDictionaryPanel />);
		});
		expect(host.textContent).toContain("No custom words yet");
	});

	it("offers the available dictionaries as an editable spelling-language picker", async () => {
		await act(async () => {
			root.render(<SpellcheckDictionaryPanel />);
		});
		const picker = host.querySelector<HTMLButtonElement>(
			'button.bs-select[aria-label="Spelling languages"]',
		);
		expect(picker).not.toBeNull();
		expect(host.textContent).toContain("Following your system languages");
		expect(host.textContent).not.toContain("Use system languages");
	});

	it("shows the saved choice with a reset back to the system languages", async () => {
		stub.languages.mockResolvedValue({ active: ["de"], available: ["en-US", "de"], chosen: ["de"] });
		await act(async () => {
			root.render(<SpellcheckDictionaryPanel />);
		});
		const reset = Array.from(host.querySelectorAll("button")).find((b) =>
			b.textContent?.includes("Use system languages"),
		);
		expect(reset).toBeDefined();
		await act(async () => {
			reset?.click();
		});
		expect(stub.setLanguages).toHaveBeenCalledWith(null);
		expect(host.textContent).toContain("Following your system languages");
	});

	it("keeps the read-only auto-detect note where the platform exposes no list (macOS)", async () => {
		stub.languages.mockResolvedValue({ active: [], available: [], chosen: null });
		await act(async () => {
			root.render(<SpellcheckDictionaryPanel />);
		});
		expect(host.querySelector("button.bs-select")).toBeNull();
		expect(host.textContent).toContain("detected automatically");
	});
});
