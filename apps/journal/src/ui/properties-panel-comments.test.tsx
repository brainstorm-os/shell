/**
 * @vitest-environment jsdom
 *
 * Journal right-panel comments mount (B11.9). Pins:
 *   1. With a comment-capable runtime (vaultEntities + entities mutations)
 *      and an entry, the island renders the shared tab strip and the active
 *      tab switches between the Journal properties shell and the shared
 *      comments panel.
 *   2. Without the mutation surface (preview / standalone), the island
 *      degrades to the properties-only panel — no tab strip.
 */

import { RightPanelTab } from "@brainstorm-os/editor";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildJournalT } from "../logic/journal-i18n";
import type { JournalRuntime } from "../runtime";
import type { JournalEntry } from "../types/entry";
import { type JournalPropertiesHandle, mountJournalProperties } from "./properties-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOTE_ID = "journal-2026-06-09";

function entry(): JournalEntry {
	return {
		noteId: NOTE_ID,
		icon: null,
		dateEpochMs: Date.UTC(2026, 5, 9),
		dateKey: "2026-06-09",
		rawTitle: "2026-06-09",
		preview: "",
		wordCount: 0,
		seedBody: null,
		values: {},
		mood: null,
		habits: [],
		createdAt: 1,
		updatedAt: 1,
	};
}

function fakeRuntime(withMutations: boolean): JournalRuntime {
	const services: Record<string, unknown> = {
		vaultEntities: {
			list: () => Promise.resolve({ entities: [], links: [] }),
			queryPattern: () => Promise.reject(new Error("unused")),
			onChange: () => ({ unsubscribe() {} }),
		},
		properties: {
			list: () => Promise.resolve([]),
			dictionaries: () => Promise.resolve([]),
			onChange: () => ({ unsubscribe() {} }),
		},
	};
	if (withMutations) {
		services.entities = {
			loadDoc: () => Promise.resolve({ snapshotB64: null }),
			applyDoc: () => Promise.resolve(),
			closeDoc: () => Promise.resolve(),
			create: () => Promise.reject(new Error("unused")),
			update: () => Promise.reject(new Error("unused")),
			delete: () => Promise.resolve(),
		};
	}
	return {
		on() {},
		services,
	} as unknown as JournalRuntime;
}

let host: HTMLDivElement;
let handle: JournalPropertiesHandle | null = null;

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
});

afterEach(() => {
	act(() => handle?.dispose());
	handle = null;
	host.remove();
	(window as { brainstorm?: unknown }).brainstorm = undefined;
});

function mount(withMutations: boolean, tabRef: { tab: RightPanelTab }): void {
	(window as { brainstorm?: unknown }).brainstorm = fakeRuntime(withMutations);
	act(() => {
		handle = mountJournalProperties(host, {
			runtime: fakeRuntime(withMutations),
			t: buildJournalT(),
			getEntry: entry,
			ensureEntry: () => Promise.resolve(NOTE_ID),
			onClose: () => {},
			getActiveTab: () => tabRef.tab,
			onTabChange: (tab) => {
				tabRef.tab = tab;
				handle?.render();
			},
			getPendingCommentAnchor: () => null,
			onClearPendingComment: () => {},
			getCommentFocusRequest: () => null,
		});
	});
}

describe("Journal right-panel comments mount", () => {
	it("renders the tab strip and switches Properties ⇄ Comments", () => {
		const tabRef = { tab: RightPanelTab.Properties };
		mount(true, tabRef);
		expect(host.querySelector('[role="tablist"]')).not.toBeNull();
		expect(host.querySelector(".bs-props__inner")).not.toBeNull();
		expect(host.querySelector(".bs-comments")).toBeNull();

		const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
		act(() => tabs[1]?.click());
		expect(tabRef.tab).toBe(RightPanelTab.Comments);
		expect(host.querySelector(".bs-comments")).not.toBeNull();
		expect(host.querySelector(".bs-props__inner")).toBeNull();
	});

	it("degrades to properties-only without the entities mutation surface", () => {
		const tabRef = { tab: RightPanelTab.Properties };
		mount(false, tabRef);
		expect(host.querySelector('[role="tablist"]')).toBeNull();
		expect(host.querySelector(".bs-props__inner")).not.toBeNull();
	});
});
