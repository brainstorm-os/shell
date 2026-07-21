import type { SpellcheckBridge, SpellcheckContext } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_SPELLCHECK_MENU_LABELS,
	type SpellcheckMenuActions,
	buildSpellMenuItems,
	mountSpellcheckMenu,
	mountSpellcheckMenuFromWindow,
} from "./spellcheck-menu";

const ctx = (over: Partial<SpellcheckContext> = {}): SpellcheckContext => ({
	word: "teh",
	suggestions: ["the", "teh", "tech"],
	x: 10,
	y: 20,
	...over,
});

const actions = () => ({
	onReplace: vi.fn<(replacement: string) => void>(),
	onAddWord: vi.fn<(word: string) => void>(),
	onIgnore: vi.fn<(word: string) => void>(),
});

const fakeBridge = (over: Partial<SpellcheckBridge> = {}): SpellcheckBridge => ({
	onContext: vi.fn<SpellcheckBridge["onContext"]>().mockReturnValue(() => {}),
	replace: vi.fn<(replacement: string) => void>(),
	addWord: vi.fn<(word: string) => Promise<string[]>>().mockResolvedValue([]),
	removeWord: vi.fn<(word: string) => Promise<string[]>>().mockResolvedValue([]),
	ignoreWord: vi.fn<(word: string) => Promise<void>>().mockResolvedValue(undefined),
	listWords: vi.fn<() => Promise<string[]>>().mockResolvedValue([]),
	...over,
});

describe("buildSpellMenuItems", () => {
	it("renders one row per suggestion, each replacing on select", () => {
		const a = actions();
		const items = buildSpellMenuItems(ctx(), DEFAULT_SPELLCHECK_MENU_LABELS, a);
		expect(items.slice(0, 3).map((i) => i.label)).toEqual(["the", "teh", "tech"]);
		items[1]?.onSelect?.();
		expect(a.onReplace).toHaveBeenCalledWith("teh");
	});

	it("always appends Add-to-dictionary + Ignore rows wired to the word", () => {
		const a = actions();
		const items = buildSpellMenuItems(ctx(), DEFAULT_SPELLCHECK_MENU_LABELS, a);
		const add = items.find((i) => i.id === "spellcheck-add");
		const ignore = items.find((i) => i.id === "spellcheck-ignore");
		add?.onSelect?.();
		ignore?.onSelect?.();
		expect(a.onAddWord).toHaveBeenCalledWith("teh");
		expect(a.onIgnore).toHaveBeenCalledWith("teh");
	});

	it("shows a disabled No-suggestions row (still with the action rows)", () => {
		const items = buildSpellMenuItems(
			ctx({ suggestions: [] }),
			DEFAULT_SPELLCHECK_MENU_LABELS,
			actions(),
		);
		expect(items[0]?.disabled).toBe(true);
		expect(items[0]?.label).toBe(DEFAULT_SPELLCHECK_MENU_LABELS.noSuggestions);
		expect(items.some((i) => i.id === "spellcheck-add")).toBe(true);
	});
});

describe("mountSpellcheckMenu", () => {
	it("is a no-op when the shell exposes no spellcheck bridge", () => {
		expect(() => mountSpellcheckMenu(undefined)()).not.toThrow();
	});

	it("subscribes to the bridge and unsubscribes on dispose", () => {
		const unsub = vi.fn();
		const dispose = mountSpellcheckMenu(fakeBridge({ onContext: vi.fn().mockReturnValue(unsub) }));
		dispose();
		expect(unsub).toHaveBeenCalledTimes(1);
	});
});

describe("mountSpellcheckMenuFromWindow", () => {
	const g = globalThis as { brainstorm?: unknown };

	it("reads the bridge off the runtime global and subscribes", () => {
		const onContext = vi.fn().mockReturnValue(() => {});
		g.brainstorm = { spellcheck: fakeBridge({ onContext }) };
		try {
			mountSpellcheckMenuFromWindow();
			expect(onContext).toHaveBeenCalledTimes(1);
		} finally {
			g.brainstorm = undefined;
		}
	});

	it("is a no-op when the runtime global is absent", () => {
		g.brainstorm = undefined;
		expect(() => mountSpellcheckMenuFromWindow()()).not.toThrow();
	});
});
