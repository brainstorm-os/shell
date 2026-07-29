// @vitest-environment jsdom
/**
 * POLISH-FN-1 — "New chat" must actually start a new chat.
 *
 * The regression: `newChat` cleared the selection to `null`, and the
 * defaulting effect ("select the most recent conversation once one exists")
 * treated that same `null` as "nothing chosen yet" and re-selected
 * `conversations[0]` on the very next render. The header snapped back to the
 * previous thread and the next turn's messages were appended to it — captured
 * in the `VID-build-apps` dry-run, where three New-chat clicks left the header
 * on "Coffee-line name ideas" and the agent's output landed there.
 *
 * A conversation is minted lazily on the first message, so New chat must
 * persist NOTHING until the user sends — clicking it repeatedly may not leave
 * phantom empty conversations behind.
 */

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentApp } from "./app";
import { flush, renderInto } from "./test/render";

const CONVERSATION_TYPE = "brainstorm/Conversation/v1";
const MESSAGE_TYPE = "brainstorm/Message/v1";

type StoreEntity = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
	deletedAt: number | null;
	ownerAppId: string;
};

type Created = { id: string; type: string; properties: Record<string, unknown> };

/** An in-memory vault with the write surface the send path needs, plus a
 *  stub AI provider so a turn completes without a model. */
function installShell(seed: StoreEntity[]): {
	created: Created[];
	entities: StoreEntity[];
	generate: ReturnType<typeof vi.fn>;
} {
	const entities = [...seed];
	const created: Created[] = [];
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of [...listeners]) listener();
	};
	let seq = entities.length;
	const create = vi.fn(async (type: string, properties: Record<string, unknown>) => {
		seq += 1;
		// Time-sortable ids: the sidebar sorts conversations newest-first on id.
		const id = `ent_${String(seq).padStart(4, "0")}`;
		entities.push({
			id,
			type,
			properties,
			createdAt: seq,
			updatedAt: seq,
			deletedAt: null,
			ownerAppId: "io.brainstorm.agent",
		});
		created.push({ id, type, properties });
		notify();
		return { id };
	});
	const generate = vi.fn(async () => ({
		content: "Sure — here you go.",
		provider: "stub",
		model: "stub-1",
	}));
	window.brainstorm = {
		capabilities: [],
		services: {
			vaultEntities: {
				list: async () => ({ entities: entities.map((e) => ({ ...e })), links: [] }),
				onChange(listener: () => void) {
					listeners.add(listener);
					return { unsubscribe: () => listeners.delete(listener) };
				},
			},
			entities: {
				create,
				update: vi.fn(async () => undefined),
			},
			ai: { generate },
		},
	} as unknown as typeof window.brainstorm;
	return { created, entities, generate };
}

function conversation(id: string, title: string, at: number): StoreEntity {
	return {
		id,
		type: CONVERSATION_TYPE,
		properties: { title },
		createdAt: at,
		updatedAt: at,
		deletedAt: null,
		ownerAppId: "io.brainstorm.agent",
	};
}

function message(id: string, conv: string, body: string, at: number): StoreEntity {
	return {
		id,
		type: MESSAGE_TYPE,
		properties: {
			conversation: conv,
			role: "user",
			body,
			createdAt: "2026-07-01T00:00:00.000Z",
			seq: 0,
		},
		createdAt: at,
		updatedAt: at,
		deletedAt: null,
		ownerAppId: "io.brainstorm.agent",
	};
}

let handle: Awaited<ReturnType<typeof renderInto>> | null = null;

beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn();
});

afterEach(async () => {
	await handle?.unmount();
	handle = null;
	window.brainstorm = undefined;
});

function newChatButton(): HTMLButtonElement {
	const btn = handle?.container.querySelector<HTMLButtonElement>(
		'.app-header__right [aria-label="New chat"]',
	);
	if (!btn) throw new Error("New chat button not mounted");
	return btn;
}

function headerTitle(): string {
	return handle?.container.querySelector(".app-header__title")?.textContent ?? "";
}

/** A serialized single-paragraph editor state. The app doesn't depend on
 *  `lexical` directly (the composer comes from `@brainstorm-os/editor`), so the
 *  draft is seeded through the editor's own `parseEditorState` rather than the
 *  `$create*` node factories. */
function paragraphState(value: string): string {
	return JSON.stringify({
		root: {
			children: [
				{
					children: [
						{
							detail: 0,
							format: 0,
							mode: "normal",
							style: "",
							text: value,
							type: "text",
							version: 1,
						},
					],
					direction: "ltr",
					format: "",
					indent: 0,
					type: "paragraph",
					version: 1,
				},
			],
			direction: "ltr",
			format: "",
			indent: 0,
			type: "root",
			version: 1,
		},
	});
}

type ComposerEditor = {
	parseEditorState(json: string): unknown;
	setEditorState(state: unknown): void;
};

/** Replace the composer draft. jsdom can't drive a contenteditable through
 *  real `beforeinput` edits, so reach the Lexical editor the composer stashes
 *  on its content root (same technique as the Chat suite). */
function typeComposer(value: string): void {
	const content = handle?.container.querySelector<HTMLElement>(
		".agent__input .bs-compact-editor__content",
	);
	if (!content) throw new Error("composer not mounted");
	const editor = (content as unknown as { __lexicalEditor?: ComposerEditor }).__lexicalEditor;
	if (!editor) throw new Error("no Lexical editor on the composer");
	act(() => {
		editor.setEditorState(editor.parseEditorState(paragraphState(value)));
	});
}

async function send(): Promise<void> {
	const button = handle?.container.querySelector<HTMLButtonElement>('[data-testid="agent-send"]');
	if (!button) throw new Error("send button not mounted");
	expect(button.disabled).toBe(false);
	await act(async () => {
		button.click();
	});
	await flush();
	await flush();
}

async function mountWithHistory(): Promise<ReturnType<typeof installShell>> {
	const shell = installShell([
		conversation("ent_0001", "Coffee-line name ideas", 1),
		message("ent_0002", "ent_0001", "give me ten names", 2),
	]);
	handle = await renderInto(<AgentApp />);
	await flush();
	await flush();
	await vi.waitFor(() => expect(headerTitle()).toBe("Coffee-line name ideas"));
	return shell;
}

describe("New chat (POLISH-FN-1)", () => {
	it("clears the transcript and stays cleared — the old thread is not re-selected", async () => {
		await mountWithHistory();
		expect(
			handle?.container.querySelectorAll('[data-testid="agent-transcript"] .agent__msg').length,
		).toBe(1);

		act(() => newChatButton().click());
		await flush();
		await flush();
		// The defaulting effect used to fire here and snap the header back.
		expect(headerTitle()).toBe("Agent");
		expect(
			handle?.container.querySelectorAll('[data-testid="agent-transcript"] .agent__msg').length,
		).toBe(0);
		// Sidebar keeps the previous thread, now unselected — still reachable.
		const convs = [...(handle?.container.querySelectorAll(".agent__conv") ?? [])];
		expect(convs.map((c) => c.textContent)).toEqual(["Coffee-line name ideas"]);
		expect(convs[0]?.classList.contains("agent__conv--active")).toBe(false);
	});

	it("the next turn lands in a NEW conversation, leaving the old one intact", async () => {
		const { created } = await mountWithHistory();

		act(() => newChatButton().click());
		await flush();
		typeComposer("draft a launch note");
		await send();

		const conversations = created.filter((c) => c.type === CONVERSATION_TYPE);
		expect(conversations).toHaveLength(1);
		const newConvId = conversations[0]?.id;
		expect(newConvId).not.toBe("ent_0001");

		// EVERY message this turn persisted belongs to the new thread.
		const messages = created.filter((c) => c.type === MESSAGE_TYPE);
		expect(messages.length).toBeGreaterThanOrEqual(2);
		for (const m of messages) expect(m.properties.conversation).toBe(newConvId);

		// The header follows the thread the turn landed in.
		await vi.waitFor(() => expect(headerTitle()).not.toBe("Coffee-line name ideas"), {
			timeout: 3000,
		});

		// The previous conversation still has its original message and nothing else.
		await vi.waitFor(
			() => {
				const convs = [...(handle?.container.querySelectorAll(".agent__conv") ?? [])];
				expect(convs).toHaveLength(2);
			},
			{ timeout: 3000 },
		);
		const previous = [...(handle?.container.querySelectorAll(".agent__conv") ?? [])].find(
			(c) => c.textContent === "Coffee-line name ideas",
		) as HTMLButtonElement | undefined;
		expect(previous).toBeTruthy();
		await act(async () => previous?.click());
		await flush();
		const bodies = [
			...(handle?.container.querySelectorAll('[data-testid="agent-transcript"] .agent__msg-body') ??
				[]),
		].map((n) => n.textContent);
		expect(bodies).toEqual(["give me ten names"]);
	});

	it("rapid double-click spawns no phantom conversations", async () => {
		const { created } = await mountWithHistory();
		act(() => {
			const btn = newChatButton();
			btn.click();
			btn.click();
			btn.click();
		});
		await flush();
		await flush();
		expect(created.filter((c) => c.type === CONVERSATION_TYPE)).toHaveLength(0);
		expect(headerTitle()).toBe("Agent");

		// …and the turn that follows the burst still creates exactly one.
		typeComposer("hello");
		await send();
		expect(created.filter((c) => c.type === CONVERSATION_TYPE)).toHaveLength(1);
	});
});
