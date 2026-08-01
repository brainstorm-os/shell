// @vitest-environment jsdom
/**
 * App-level smoke tests for the Chat React chrome: live channel list, empty
 * states, selecting a channel renders its messages, the composer persists a
 * `participant`-sender `Message/v1`, and the New-channel popover persists a
 * `Channel/v1`. The pure derivation/ordering/grouping lives in logic/chat.ts
 * (its own suite); these assert the shell wiring around it.
 */

import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from "lexical";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatApp } from "./app";
import { CHANNEL_TYPE, MESSAGE_TYPE } from "./logic/chat";
import { READ_WATERMARKS_KEY } from "./logic/unread";

vi.mock("@brainstorm-os/sdk/object-menu", () => ({
	openAnchoredMenu: vi.fn(),
	closeObjectMenu: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type StubEntity = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	/** The row's host-written `created_by` — the snapshot's `ownerAppId`. */
	ownerAppId?: string;
};

const created: { type: string; properties: Record<string, unknown> }[] = [];

type StorageStub = {
	get: (key: string) => Promise<unknown>;
	put: (key: string, value: unknown) => Promise<void>;
};

/** 7.14 — records the app-icon badge mirror (`services.ui.badge`). */
const badgeSet = vi.fn(() => Promise.resolve());

/** Agent-Teams-3 — the host's proposal-decision surface + the `open` intent the
 *  approved card's back-link dispatches. */
const approveProposal = vi.fn(() =>
	Promise.resolve({ ok: true, status: "approved", createdEntityId: "ent_42" }),
);
const discardProposal = vi.fn(() => Promise.resolve({ ok: true, status: "discarded" }));
const dispatchIntent = vi.fn(() => Promise.resolve({ ok: true }));

function installShell(entities: StubEntity[], storageOverride?: StorageStub): void {
	created.length = 0;
	badgeSet.mockClear();
	approveProposal.mockClear();
	discardProposal.mockClear();
	dispatchIntent.mockClear();
	const kv = new Map<string, unknown>();
	(window as { brainstorm?: unknown }).brainstorm = {
		services: {
			ui: { badge: { set: badgeSet, clear: vi.fn(() => Promise.resolve()) } },
			agentProposals: { approve: approveProposal, discard: discardProposal },
			intents: { dispatch: dispatchIntent },
			vaultEntities: {
				list: () => Promise.resolve({ entities, links: [] }),
				onChange: () => ({ unsubscribe: () => {} }),
			},
			entities: {
				get: vi.fn(() => Promise.resolve(null)),
				create: vi.fn((type: string, properties: Record<string, unknown>) => {
					const ent = { id: `new-${created.length}`, type, properties };
					created.push({ type, properties });
					return Promise.resolve(ent);
				}),
				update: vi.fn(() => Promise.resolve(null)),
				delete: vi.fn(() => Promise.resolve(null)),
			},
			storage: storageOverride ?? {
				get: (key: string) => Promise.resolve(kv.get(key) ?? null),
				put: (key: string, value: unknown) => {
					kv.set(key, value);
					return Promise.resolve();
				},
			},
		},
	};
}

function channel(id: string, name: string): StubEntity {
	return { id, type: CHANNEL_TYPE, properties: { name, createdAt: "2026-06-20T09:00:00.000Z" } };
}

function message(id: string, channelId: string, name: string, body: string): StubEntity {
	return {
		id,
		type: MESSAGE_TYPE,
		properties: {
			conversation: channelId,
			body,
			createdAt: "2026-06-20T10:00:00.000Z",
			seq: Number(id.replace(/\D/g, "")) || 0,
			sender: { kind: "participant", personRef: `p-${name}`, displayName: name },
		},
	};
}

let container: HTMLElement;
let root: Root;

async function mount(entities: StubEntity[], storageOverride?: StorageStub): Promise<void> {
	installShell(entities, storageOverride);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root.render(<ChatApp />);
	});
	// Flush the async vault snapshot + identity load.
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	(window as { brainstorm?: unknown }).brainstorm = undefined;
});

/** Type into the composer's CompactEditor. Reaches the Lexical editor stashed
 *  on its contenteditable root (`__lexicalEditor`) and replaces the body —
 *  jsdom can't simulate real `beforeinput` editing into a contenteditable. */
function typeComposer(value: string): void {
	const content = container.querySelector<HTMLElement>(
		".chat__composer-input .bs-compact-editor__content",
	);
	if (!content) throw new Error("composer editor not mounted");
	const editor = (content as unknown as { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
	if (!editor) throw new Error("no Lexical editor on the composer");
	act(() => {
		editor.update(
			() => {
				const root = $getRoot();
				root.clear();
				const p = $createParagraphNode();
				p.append($createTextNode(value));
				root.append(p);
			},
			{ discrete: true },
		);
	});
}

describe("ChatApp", () => {
	beforeEach(() => {
		created.length = 0;
	});

	it("renders the live channel list and selects the first channel", async () => {
		await mount([channel("c1", "general"), channel("c2", "design")]);
		const names = [...container.querySelectorAll(".chat__channel-name")].map((n) => n.textContent);
		expect(names).toEqual(["general", "design"]);
		expect(container.querySelector('[data-testid="active-channel"]')?.textContent).toContain(
			"general",
		);
	});

	it("shows the no-channel placeholder when the vault has none", async () => {
		await mount([]);
		expect(container.querySelector('[data-testid="no-channel"]')).not.toBeNull();
	});

	it("disables the members toggle when no channel is open (no dead button)", async () => {
		await mount([]);
		const toggle = container.querySelector('[data-testid="members-toggle"]') as HTMLButtonElement;
		expect(toggle.disabled).toBe(true);
		expect(toggle.getAttribute("aria-pressed")).toBe("false");
		await act(async () => {
			toggle.click();
		});
		// Clicking a disabled toggle must not open the members panel.
		expect(container.querySelector(".chat")?.getAttribute("data-members-open")).toBe("false");
	});

	it("enables the members toggle once a channel is active", async () => {
		await mount([channel("c1", "general")]);
		const toggle = container.querySelector('[data-testid="members-toggle"]') as HTMLButtonElement;
		expect(toggle.disabled).toBe(false);
		await act(async () => {
			toggle.click();
		});
		expect(container.querySelector(".chat")?.getAttribute("data-members-open")).toBe("true");
	});

	it("renders a selected channel's messages grouped by author", async () => {
		await mount([
			channel("c1", "general"),
			message("m0", "c1", "Mira", "kickoff"),
			message("m1", "c1", "Kai", "on it"),
		]);
		const lines = [...container.querySelectorAll(".chat__line")].map((n) => n.textContent);
		expect(lines).toEqual(["kickoff", "on it"]);
		const authors = [...container.querySelectorAll(".chat__author")].map((n) => n.textContent);
		expect(authors).toEqual(["Mira", "Kai"]);
	});

	it("persists a participant-sender Message/v1 (plain + rich body) when the composer sends", async () => {
		await mount([channel("c1", "general")]);
		typeComposer("hello team");
		const send = container.querySelector(".chat__send") as HTMLButtonElement;
		await act(async () => {
			send.click();
		});
		const msg = created.find((c) => c.type === MESSAGE_TYPE);
		expect(msg).toBeDefined();
		expect(msg?.properties.body).toBe("hello team");
		expect(msg?.properties.conversation).toBe("c1");
		expect((msg?.properties.sender as { kind: string }).kind).toBe("participant");
		// The rich body is the serialized Lexical state, flattening to the body.
		const rich = JSON.parse(msg?.properties.richBody as string) as { root: unknown };
		expect(rich.root).toBeDefined();
	});

	it("sends even before the async identity load resolves (no silent no-op)", async () => {
		// Storage whose get/put never resolve — models a slow / failed IPC
		// round-trip on open. Before the fix, `personRef` stayed empty until the
		// load resolved, so a type-and-send on open silently no-opped.
		const hangingStorage: StorageStub = {
			get: () => new Promise<unknown>(() => {}),
			put: () => new Promise<void>(() => {}),
		};
		await mount([channel("c1", "general")], hangingStorage);
		typeComposer("before identity loads");
		const send = container.querySelector(".chat__send") as HTMLButtonElement;
		await act(async () => {
			send.click();
		});
		const msg = created.find((c) => c.type === MESSAGE_TYPE);
		expect(msg).toBeDefined();
		expect(msg?.properties.body).toBe("before identity loads");
		expect((msg?.properties.sender as { personRef: string }).personRef).toMatch(/^chat-person-/);
	});

	it("creates a Channel/v1 from the New-channel popover", async () => {
		await mount([]);
		const newBtn = container.querySelector('[aria-label="New channel"]') as HTMLButtonElement;
		await act(async () => {
			newBtn.click();
		});
		const input = document.querySelector(".bs-input") as HTMLInputElement;
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, "announcements");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const createBtn = [...document.querySelectorAll(".bs-popover button, .bs-btn")].find(
			(b) => b.textContent === "Create channel",
		) as HTMLButtonElement;
		await act(async () => {
			createBtn.click();
		});
		const ch = created.find((c) => c.type === CHANNEL_TYPE);
		expect(ch?.properties.name).toBe("announcements");
	});
});

describe("ChatApp — agent proposal cards (Agent-Teams-3)", () => {
	const AGENT_FINGERPRINT = "ed25519:beef";

	/** The vault's own agent member — SHELL-authored, so it can vouch for a card
	 *  (Agent-Teams-3 closure b). */
	const localAgent: StubEntity = {
		id: "agt_1",
		type: "brainstorm/Agent/v1",
		ownerAppId: "shell",
		properties: {
			fingerprint: AGENT_FINGERPRINT,
			pubkey: "pk-researcher",
			displayName: "Researcher",
		},
	};

	function proposalMessage(
		id: string,
		channelId: string,
		agentProposal: unknown,
		ownerAppId = AGENT_FINGERPRINT,
	): StubEntity {
		return {
			id,
			type: MESSAGE_TYPE,
			ownerAppId,
			properties: {
				conversation: channelId,
				body: "Proposed task: Ship the release notes — approve it to save it.",
				createdAt: "2026-06-20T10:00:00.000Z",
				seq: 1,
				sender: { kind: "participant", personRef: "pk-researcher", displayName: "Researcher" },
				agentProposal,
			},
		};
	}

	const pendingTask = {
		artifact: {
			id: "prop-1",
			kind: "task",
			entityType: "brainstorm/Task/v1",
			fields: { title: "Ship the release notes" },
			summary: "Ship the release notes",
		},
		status: "pending",
	};

	it("renders a card for a pending proposal and approves through the host service", async () => {
		await mount([localAgent, channel("c1", "general"), proposalMessage("m1", "c1", pendingTask)]);
		expect(container.querySelector('[data-testid="chat-proposal"]')).not.toBeNull();
		const approve = container.querySelector(
			'[data-testid="chat-proposal-approve"]',
		) as HTMLButtonElement;
		await act(async () => {
			approve.click();
		});
		expect(approveProposal).toHaveBeenCalledWith({ messageId: "m1" });
	});

	it("discards through the host service", async () => {
		await mount([localAgent, channel("c1", "general"), proposalMessage("m1", "c1", pendingTask)]);
		const discard = container.querySelector(
			'[data-testid="chat-proposal-discard"]',
		) as HTMLButtonElement;
		await act(async () => {
			discard.click();
		});
		expect(discardProposal).toHaveBeenCalledWith({ messageId: "m1" });
	});

	it("opens what an approval created through the shared open intent", async () => {
		await mount([
			localAgent,
			channel("c1", "general"),
			proposalMessage("m1", "c1", {
				...pendingTask,
				status: "approved",
				createdEntityId: "ent_42",
			}),
		]);
		const open = container.querySelector('[data-testid="chat-proposal-open"]') as HTMLButtonElement;
		await act(async () => {
			open.click();
		});
		expect(dispatchIntent).toHaveBeenCalledWith({
			verb: "open",
			payload: { entityId: "ent_42", entityType: "brainstorm/Task/v1" },
		});
	});

	it("renders a MALFORMED proposal as an ordinary message — never an approvable card", async () => {
		await mount([
			localAgent,
			channel("c1", "general"),
			// A kind the channel path cannot honour: main would refuse the approval.
			proposalMessage("m1", "c1", {
				...pendingTask,
				artifact: { ...pendingTask.artifact, kind: "database" },
			}),
		]);
		expect(container.querySelector('[data-testid="chat-proposal"]')).toBeNull();
		expect(container.querySelector(".chat__line")?.textContent).toContain(
			"Proposed task: Ship the release notes",
		);
	});

	it("surfaces a rejected decision in the card", async () => {
		approveProposal.mockResolvedValueOnce({
			ok: false,
			reason: "already-decided",
		} as unknown as { ok: true; status: string; createdEntityId: string });
		await mount([localAgent, channel("c1", "general"), proposalMessage("m1", "c1", pendingTask)]);
		const approve = container.querySelector(
			'[data-testid="chat-proposal-approve"]',
		) as HTMLButtonElement;
		await act(async () => {
			approve.click();
		});
		expect(container.querySelector('[data-testid="chat-proposal-error"]')?.textContent).toBe(
			"Someone already decided this one.",
		);
	});

	it("CLOSURE (b): a card whose author is NOT a local agent renders as an ordinary message", async () => {
		// The phishing surface slice 2 left open: a card synced in from another
		// vault (or pasted by an app) showed an Approve button that main could
		// only ever refuse. Now the message's HOST-written author must resolve to
		// a shell-authored `Agent/v1` record before a card renders at all.
		for (const foreignAuthor of ["brainstorm", `${AGENT_FINGERPRINT} (received)`, "io.evil.app"]) {
			await mount([
				localAgent,
				channel("c1", "general"),
				proposalMessage("m1", "c1", pendingTask, foreignAuthor),
			]);
			expect(container.querySelector('[data-testid="chat-proposal"]')).toBeNull();
			expect(container.querySelector('[data-testid="chat-proposal-approve"]')).toBeNull();
			// The body still reads honestly on its own — no silent drop.
			expect(container.querySelector(".chat__line")?.textContent).toContain(
				"Proposed task: Ship the release notes",
			);
			act(() => root.unmount());
			container.remove();
		}
		// Re-mount so the shared afterEach has a live root to tear down.
		await mount([channel("c1", "general")]);
	});

	it("CLOSURE (b): an Agent/v1 record NOT authored by the shell cannot vouch for a card", async () => {
		await mount([
			{ ...localAgent, ownerAppId: "io.evil.app" },
			channel("c1", "general"),
			proposalMessage("m1", "c1", pendingTask),
		]);
		expect(container.querySelector('[data-testid="chat-proposal"]')).toBeNull();
	});
});

describe("ChatApp — app-icon unread badge (7.14)", () => {
	function seededStorage(seed: Record<string, unknown>): {
		kv: Map<string, unknown>;
		stub: StorageStub;
	} {
		const kv = new Map<string, unknown>(Object.entries(seed));
		return {
			kv,
			stub: {
				get: (key) => Promise.resolve(kv.get(key) ?? null),
				put: (key, value) => {
					kv.set(key, value);
					return Promise.resolve();
				},
			},
		};
	}

	it("badges others' messages above the stored watermark and clears when the channel is opened", async () => {
		const { kv, stub } = seededStorage({ [READ_WATERMARKS_KEY]: { c2: 0 } });
		await mount(
			[
				channel("c1", "general"),
				channel("c2", "design"),
				message("m0", "c2", "Mira", "seen already"), // seq 0 — at the watermark
				message("m1", "c2", "Mira", "new since"), // seq 1 — above it
			],
			stub,
		);
		await act(async () => undefined);
		// c1 auto-selects; the c2 message above the watermark badges.
		expect(badgeSet).toHaveBeenLastCalledWith({ count: 1 });

		// Opening the channel is the app-owned "seen" gesture — the watermark
		// advances, the badge clears, and the ack persists.
		const designBtn = [...container.querySelectorAll<HTMLButtonElement>(".chat__channel")].find((b) =>
			b.textContent?.includes("design"),
		);
		await act(async () => {
			designBtn?.click();
		});
		await act(async () => undefined);
		expect(badgeSet).toHaveBeenLastCalledWith({ count: 0 });
		expect(kv.get(READ_WATERMARKS_KEY)).toMatchObject({ c2: 1 });
	});

	it("first observation baselines a channel — history never badges on first run", async () => {
		const { kv, stub } = seededStorage({});
		await mount(
			[channel("c1", "general"), channel("c2", "design"), message("m3", "c2", "Mira", "old talk")],
			stub,
		);
		await act(async () => undefined);
		expect(badgeSet).toHaveBeenLastCalledWith({ count: 0 });
		// The baseline ack persisted, so the next arrival counts from here.
		expect(kv.get(READ_WATERMARKS_KEY)).toMatchObject({ c2: 3 });
	});
});
