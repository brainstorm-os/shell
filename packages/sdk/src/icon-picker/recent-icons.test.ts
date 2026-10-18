import { IconKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	RECENT_ICONS_CAP,
	RECENT_ICONS_STORAGE_KEY,
	loadRecentIcons,
	parseRecentIcons,
	pushRecentIcon,
	recentsOfKind,
	recordRecentIcon,
} from "./recent-icons";

function memoryStorage(): Storage {
	const map = new Map<string, string>();
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => {
			map.set(k, v);
		},
	} as unknown as Storage;
}

describe("recent icons (8.11)", () => {
	it("puts the newest first and de-duplicates by kind + value", () => {
		let list = pushRecentIcon([], { kind: IconKind.Emoji, value: "🙂" });
		list = pushRecentIcon(list, { kind: IconKind.Pack, value: "phosphor/star" });
		list = pushRecentIcon(list, { kind: IconKind.Emoji, value: "🙂" });
		expect(list).toEqual([
			{ kind: IconKind.Emoji, value: "🙂" },
			{ kind: IconKind.Pack, value: "phosphor/star" },
		]);
	});

	it("drops a pack tint and never records an uploaded image", () => {
		const list = pushRecentIcon([], { kind: IconKind.Pack, value: "phosphor/star", color: "#f00" });
		expect(list).toEqual([{ kind: IconKind.Pack, value: "phosphor/star" }]);
		expect(pushRecentIcon(list, { kind: IconKind.Image, value: "brainstorm://icon/x.png" })).toEqual(
			list,
		);
	});

	it("is bounded", () => {
		let list: ReturnType<typeof pushRecentIcon> = [];
		for (let i = 0; i < RECENT_ICONS_CAP + 10; i += 1) {
			list = pushRecentIcon(list, { kind: IconKind.Pack, value: `phosphor/i${i}` });
		}
		expect(list).toHaveLength(RECENT_ICONS_CAP);
		expect(list[0]?.value).toBe(`phosphor/i${RECENT_ICONS_CAP + 9}`);
	});

	it("re-validates whatever is stored", () => {
		expect(parseRecentIcons("nope")).toEqual([]);
		expect(
			parseRecentIcons([
				{ kind: IconKind.Emoji, value: "🎉" },
				{ kind: IconKind.Image, value: "x" },
				{ kind: IconKind.Emoji, value: "" },
				{ kind: IconKind.Emoji, value: "🎉" },
				{ kind: IconKind.Pack, value: "p".repeat(500) },
				null,
			]),
		).toEqual([{ kind: IconKind.Emoji, value: "🎉" }]);
	});

	it("persists picks and survives corrupt storage", () => {
		const store = memoryStorage();
		recordRecentIcon({ kind: IconKind.Emoji, value: "🔥" }, store);
		recordRecentIcon({ kind: IconKind.Pack, value: "phosphor/house" }, store);
		const loaded = loadRecentIcons(store);
		expect(recentsOfKind(loaded, IconKind.Emoji)).toEqual(["🔥"]);
		expect(recentsOfKind(loaded, IconKind.Pack)).toEqual(["phosphor/house"]);
		store.setItem(RECENT_ICONS_STORAGE_KEY, "{broken");
		expect(loadRecentIcons(store)).toEqual([]);
		expect(loadRecentIcons(null)).toEqual([]);
	});
});
