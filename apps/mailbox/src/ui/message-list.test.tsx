// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groupThreads } from "../logic/mail-view";
import type { MessageView } from "../types/mail-view";
import { MessageList } from "./message-list";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

function message(id: string, threadKey: string, subject: string): MessageView {
	return {
		id,
		accountRef: "acc-1",
		folderRefs: ["f-1"],
		messageId: `<${id}@example.test>`,
		threadKey,
		from: [{ address: "dana@example.test" }],
		to: [],
		cc: [],
		subject,
		receivedAt: 1_700_000_000_000,
		bodyText: "body",
		bodyHtmlSafe: "",
		attachments: [],
		flags: [],
		tags: [],
		unread: false,
		flagged: false,
	};
}

function renderList(messages: MessageView[], onSelect: (id: string) => void): void {
	const threads = groupThreads(messages);
	act(() => {
		root.render(
			<MessageList
				messages={messages}
				threads={threads}
				threaded
				expandedThreads={new Set()}
				activeId={null}
				now={1_700_000_000_000}
				query=""
				onQueryChange={() => {}}
				onSelect={onSelect}
				onToggleThreaded={() => {}}
				onToggleThreadExpand={() => {}}
			/>,
		);
	});
}

describe("MessageList threaded rendering", () => {
	it("opens a single-message thread on the FIRST click — no expand step", () => {
		const onSelect = vi.fn();
		renderList([message("m-1", "t-1", "solo")], onSelect);
		expect(host.querySelector(".mb-row--thread")).toBeNull();
		expect(host.querySelector(".mb-thread__chevron")).toBeNull();
		const row = host.querySelector<HTMLButtonElement>(".mb-row");
		expect(row).not.toBeNull();
		act(() => row?.click());
		expect(onSelect).toHaveBeenCalledWith("m-1");
	});

	it("keeps the expander chrome for real multi-message conversations", () => {
		const onSelect = vi.fn();
		renderList([message("m-1", "t-1", "re: topic"), message("m-2", "t-1", "topic")], onSelect);
		const threadRow = host.querySelector(".mb-row--thread");
		expect(threadRow).not.toBeNull();
		expect(host.querySelector(".mb-thread__chevron")).not.toBeNull();
	});
});
