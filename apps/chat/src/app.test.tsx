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
import { USER_STATE_TYPE } from "./logic/user-state";
import { USER_STATE_WRITE_DEBOUNCE_MS } from "./use-user-state";

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
	delete?: (key: string) => Promise<void>;
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

function installShell(
	entities: StubEntity[],
	storageOverride?: StorageStub,
	extraServices: Record<string, unknown> = {},
): void {
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
			...extraServices,
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

async function mount(
	entities: StubEntity[],
	storageOverride?: StorageStub,
	extraServices?: Record<string, unknown>,
): Promise<void> {
	installShell(entities, storageOverride, extraServices);
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

	// F-489: the CSS guard rides the 180ms slide, so it only lands at the END
	// of the close. The React `inert` closes that window and defends the panel
	// if the stylesheet is ever overridden.
	it("takes the collapsed sidebar out of the tab order the moment it closes", async () => {
		await mount([channel("c1", "general")]);
		const sidebar = container.querySelector(".chat__sidebar") as HTMLElement;
		expect(sidebar.hasAttribute("inert")).toBe(false);
		const toggle = container.querySelector('[data-testid="sidebar-toggle"]') as HTMLButtonElement;
		await act(async () => {
			toggle.click();
		});
		expect(sidebar.hasAttribute("inert")).toBe(true);
		expect(sidebar.getAttribute("aria-hidden")).toBe("true");
	});

	it("keeps the closed members panel out of the tab order", async () => {
		await mount([channel("c1", "general")]);
		const members = container.querySelector(".chat__members") as HTMLElement;
		expect(members.hasAttribute("inert")).toBe(true);
		expect(members.getAttribute("aria-hidden")).toBe("true");
		const toggle = container.querySelector('[data-testid="members-toggle"]') as HTMLButtonElement;
		await act(async () => {
			toggle.click();
		});
		expect(members.hasAttribute("inert")).toBe(false);
		expect(members.getAttribute("aria-hidden")).toBeNull();
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

function pressChord(key: string, mods: { cmdOrCtrl?: boolean; shift?: boolean } = {}): void {
	const isMac = /mac|iphone|ipad/i.test(navigator.platform ?? navigator.userAgent);
	act(() => {
		window.dispatchEvent(
			new KeyboardEvent("keydown", {
				key,
				bubbles: true,
				metaKey: !!mods.cmdOrCtrl && isMac,
				ctrlKey: !!mods.cmdOrCtrl && !isMac,
				shiftKey: !!mods.shift,
			}),
		);
	});
}

function typeInput(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	act(() => {
		setter?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("ChatApp — message search (Chats-1)", () => {
	const seed = (): StubEntity[] => [
		channel("c1", "general"),
		channel("c2", "design"),
		message("m1", "c1", "Mira", "kickoff at noon"),
		message("m2", "c2", "Mira", "the launch banner is ready"),
	];

	it("opens from the header, searches across channels, and jumps to + flashes the hit", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			await mount(seed());
			const toggle = container.querySelector('[data-testid="search-toggle"]') as HTMLButtonElement;
			await act(async () => toggle.click());
			expect(container.querySelector('[data-testid="search-panel"]')).not.toBeNull();
			expect(toggle.getAttribute("aria-pressed")).toBe("true");

			const input = container.querySelector('[data-testid="search-input"]') as HTMLInputElement;
			typeInput(input, "launch");
			expect(container.querySelector('[data-testid="search-status"]')?.textContent).toBe(
				"No messages match.",
			);

			await act(async () => {
				(container.querySelector('[data-testid="search-scope-all"]') as HTMLButtonElement).click();
			});
			const hits = container.querySelectorAll(".chat__search-hit");
			expect(hits).toHaveLength(1);
			expect(hits[0]?.textContent).toContain("design");
			expect(hits[0]?.textContent).toContain("launch banner");

			await act(async () => (hits[0] as HTMLButtonElement).click());
			expect(container.querySelector('[data-testid="active-channel"]')?.textContent).toContain(
				"design",
			);
			const line = container.querySelector('[data-message-id="m2"]');
			expect(line?.classList.contains("chat__line-wrap--flash")).toBe(true);
			await act(async () => {
				vi.advanceTimersByTime(3000);
			});
			expect(line?.classList.contains("chat__line-wrap--flash")).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("opens with CmdOrCtrl+F (this channel) and CmdOrCtrl+Shift+F (all), Escape closes", async () => {
		await mount(seed());
		pressChord("f", { cmdOrCtrl: true });
		expect(
			container.querySelector('[data-testid="search-scope-channel"]')?.getAttribute("aria-pressed"),
		).toBe("true");
		const input = container.querySelector('[data-testid="search-input"]') as HTMLInputElement;
		act(() => {
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect(container.querySelector('[data-testid="search-panel"]')).toBeNull();

		pressChord("f", { cmdOrCtrl: true, shift: true });
		expect(
			container.querySelector('[data-testid="search-scope-all"]')?.getAttribute("aria-pressed"),
		).toBe("true");
	});
});

describe("ChatApp — read state that follows the user (Chats-2)", () => {
	const SELF = { pubkey: "pk-me", displayName: "Me", fingerprint: "ed25519:aa" };
	const roster = {
		self: vi.fn(() => Promise.resolve(SELF)),
		members: vi.fn(() => Promise.resolve([])),
	};

	function kvStub(seed: Record<string, unknown>): { kv: Map<string, unknown>; stub: StorageStub } {
		const kv = new Map<string, unknown>(Object.entries(seed));
		return {
			kv,
			stub: {
				get: (key) => Promise.resolve(kv.get(key) ?? null),
				put: (key, value) => {
					kv.set(key, value);
					return Promise.resolve();
				},
				delete: (key: string) => {
					kv.delete(key);
					return Promise.resolve();
				},
			} as StorageStub,
		};
	}

	function userStateRow(
		id: string,
		watermarks: Record<string, number>,
		owner = "pk-me",
	): StubEntity {
		return {
			id,
			type: USER_STATE_TYPE,
			properties: { owner, watermarks, updatedAt: "2026-06-20T09:00:00.000Z" },
		};
	}

	async function settle(ms = USER_STATE_WRITE_DEBOUNCE_MS + 50): Promise<void> {
		await act(async () => {
			await new Promise((r) => setTimeout(r, ms));
		});
	}

	function services(): { entities: { update: ReturnType<typeof vi.fn> } } {
		return (window as unknown as { brainstorm: { services: never } }).brainstorm.services;
	}

	it("migrates the device-local watermarks onto a synced per-user row, then drops the local key", async () => {
		const { kv, stub } = kvStub({ [READ_WATERMARKS_KEY]: { c2: 0 } });
		await mount(
			[
				channel("c1", "general"),
				channel("c2", "design"),
				message("m0", "c2", "Mira", "seen"),
				message("m1", "c2", "Mira", "new"),
			],
			stub,
			{ roster },
		);
		await settle();
		expect(badgeSet).toHaveBeenLastCalledWith({ count: 1 });
		const row = created.find((c) => c.type === USER_STATE_TYPE);
		expect(row?.properties).toMatchObject({ owner: "pk-me", watermarks: { c1: -1, c2: 0 } });
		expect(kv.has(READ_WATERMARKS_KEY)).toBe(false);
	});

	it("honours a watermark another device wrote — nothing it already read badges here", async () => {
		const { stub } = kvStub({});
		await mount(
			[
				channel("c1", "general"),
				channel("c2", "design"),
				message("m1", "c2", "Mira", "read on my laptop"),
				message("m2", "c2", "Mira", "arrived after"),
				userStateRow("us-1", { c1: -1, c2: 1 }),
				userStateRow("us-other", { c2: -1 }, "pk-someone-else"),
			],
			stub,
			{ roster },
		);
		await settle();
		expect(badgeSet).toHaveBeenLastCalledWith({ count: 1 });
		const badge = [...container.querySelectorAll(".chat__channel")]
			.find((b) => b.textContent?.includes("design"))
			?.querySelector(".bs-count-badge");
		expect(badge?.textContent).toBe("1");
		expect(created.some((c) => c.type === USER_STATE_TYPE)).toBe(false);
	});

	it("ignores a UserState row planted through a share, even one claiming my owner", async () => {
		const { stub } = kvStub({});
		const plantedRoster = {
			self: vi.fn(() => Promise.resolve(SELF)),
			members: vi.fn((id: string) =>
				Promise.resolve(
					id === "us-0"
						? [
								{ pubkey: "pk-them", isSelf: false, role: "owner" },
								{ pubkey: "pk-me", isSelf: true, role: "editor" },
							]
						: [],
				),
			),
		};
		await mount(
			[
				channel("c1", "general"),
				channel("c2", "design"),
				message("m1", "c2", "Mira", "a"),
				message("m2", "c2", "Mira", "b"),
				userStateRow("us-0", { c2: 5 }),
				userStateRow("us-1", { c1: -1, c2: 0 }),
			],
			stub,
			{ roster: plantedRoster },
		);
		await settle();
		expect(badgeSet).toHaveBeenLastCalledWith({ count: 2 });
		pressChord("Escape", { shift: true });
		await settle();
		const updates = services().entities.update.mock.calls.map((c) => c[0]);
		expect(updates).not.toContain("us-0");
		expect(updates).toContain("us-1");
	});

	it("marks every channel read from the channel context menu and the header menu", async () => {
		const { openAnchoredMenu } = await import("@brainstorm-os/sdk/object-menu");
		const open = vi.mocked(openAnchoredMenu);
		const { stub } = kvStub({});
		await mount(
			[
				channel("c1", "general"),
				channel("c2", "design"),
				channel("c3", "random"),
				message("m1", "c2", "Mira", "a"),
				message("m2", "c3", "Mira", "b"),
				userStateRow("us-1", { c1: -1, c2: 0, c3: 1 }),
			],
			stub,
			{ roster },
		);
		await settle();
		expect(badgeSet).toHaveBeenLastCalledWith({ count: 2 });

		const design = [...container.querySelectorAll<HTMLButtonElement>(".chat__channel")].find((b) =>
			b.textContent?.includes("design"),
		);
		open.mockClear();
		act(() => {
			design?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		});
		const items = open.mock.calls[0]?.[1] ?? [];
		expect(items.map((i) => i.label)).toEqual(["Mark as read", "Mark all as read"]);
		await act(async () => items[1]?.onSelect?.());
		expect(badgeSet).toHaveBeenLastCalledWith({ count: 0 });
		expect(container.querySelector(".chat__channel .bs-count-badge")).toBeNull();
		await settle();
		expect(services().entities.update).toHaveBeenLastCalledWith(
			"us-1",
			expect.objectContaining({ watermarks: { c1: -1, c2: 1, c3: 2 } }),
		);

		open.mockClear();
		act(() => {
			(container.querySelector(".bs-object-menu__more") as HTMLButtonElement).click();
		});
		const header = open.mock.calls[0]?.[1] ?? [];
		const markAll = header.find((i) => i.label === "Mark all as read");
		expect(markAll?.disabled).toBe(true);
	});

	it("Shift+Escape marks all as read", async () => {
		const { stub } = kvStub({});
		await mount(
			[
				channel("c1", "general"),
				channel("c2", "design"),
				message("m1", "c2", "Mira", "a"),
				userStateRow("us-1", { c1: -1, c2: 0 }),
			],
			stub,
			{ roster },
		);
		await settle();
		expect(badgeSet).toHaveBeenLastCalledWith({ count: 1 });
		pressChord("Escape", { shift: true });
		await act(async () => undefined);
		expect(badgeSet).toHaveBeenLastCalledWith({ count: 0 });
	});
});

describe("ChatApp — composer expand + absolute timestamps (Chats-3)", () => {
	it("expands and collapses the composer from its button and CmdOrCtrl+Shift+E", async () => {
		await mount([channel("c1", "general")]);
		const wrap = () => container.querySelector('[data-testid="composer"]') as HTMLElement;
		const btn = container.querySelector('[data-testid="composer-expand"]') as HTMLButtonElement;
		expect(wrap().classList.contains("chat__composer-wrap--expanded")).toBe(false);
		await act(async () => btn.click());
		expect(wrap().classList.contains("chat__composer-wrap--expanded")).toBe(true);
		expect(btn.getAttribute("aria-pressed")).toBe("true");
		pressChord("e", { cmdOrCtrl: true, shift: true });
		expect(wrap().classList.contains("chat__composer-wrap--expanded")).toBe(false);
	});

	it("toggles full dates from the header menu and persists the preference", async () => {
		const { openAnchoredMenu } = await import("@brainstorm-os/sdk/object-menu");
		const open = vi.mocked(openAnchoredMenu);
		const kv = new Map<string, unknown>();
		await mount([channel("c1", "general"), message("m1", "c1", "Mira", "hi")], {
			get: (key) => Promise.resolve(kv.get(key) ?? null),
			put: (key, value) => {
				kv.set(key, value);
				return Promise.resolve();
			},
		});
		const time = () => container.querySelector(".chat__time")?.textContent ?? "";
		expect(time()).not.toContain("2026");

		open.mockClear();
		act(() => (container.querySelector(".bs-object-menu__more") as HTMLButtonElement).click());
		const item = open.mock.calls[0]?.[1].find((i) => i.label === "Show full dates and times");
		expect(item?.selected).toBe(false);
		await act(async () => item?.onSelect?.());
		expect(time()).toContain("2026");
		expect(kv.get("chat:prefs")).toEqual({ absoluteTimestamps: true });
	});

	it("restores the persisted preference on the next launch", async () => {
		const kv = new Map<string, unknown>([["chat:prefs", { absoluteTimestamps: true }]]);
		await mount([channel("c1", "general"), message("m1", "c1", "Mira", "hi")], {
			get: (key) => Promise.resolve(kv.get(key) ?? null),
			put: () => Promise.resolve(),
		});
		await act(async () => undefined);
		expect(container.querySelector(".chat__time")?.textContent).toContain("2026");
	});
});

describe("ChatApp — preferences follow the user (Chats-3)", () => {
	it("reads the synced preference and writes a change back onto the per-user row", async () => {
		const { openAnchoredMenu } = await import("@brainstorm-os/sdk/object-menu");
		const open = vi.mocked(openAnchoredMenu);
		const roster = {
			self: vi.fn(() =>
				Promise.resolve({ pubkey: "pk-me", displayName: "Me", fingerprint: "ed25519:aa" }),
			),
			members: vi.fn(() => Promise.resolve([])),
		};
		await mount(
			[
				channel("c1", "general"),
				message("m1", "c1", "Mira", "hi"),
				{
					id: "us-1",
					type: USER_STATE_TYPE,
					properties: {
						owner: "pk-me",
						watermarks: { c1: 1 },
						prefs: { absoluteTimestamps: true },
						updatedAt: "2026-06-20T09:00:00.000Z",
					},
				},
			],
			undefined,
			{ roster },
		);
		await act(async () => undefined);
		expect(container.querySelector(".chat__time")?.textContent).toContain("2026");

		open.mockClear();
		act(() => (container.querySelector(".bs-object-menu__more") as HTMLButtonElement).click());
		const item = open.mock.calls[0]?.[1].find((i) => i.label === "Show full dates and times");
		expect(item?.selected).toBe(true);
		await act(async () => item?.onSelect?.());
		expect(container.querySelector(".chat__time")?.textContent).not.toContain("2026");
		await act(async () => {
			await new Promise((r) => setTimeout(r, USER_STATE_WRITE_DEBOUNCE_MS + 50));
		});
		const update = (
			window as unknown as {
				brainstorm: { services: { entities: { update: ReturnType<typeof vi.fn> } } };
			}
		).brainstorm.services.entities.update;
		expect(update).toHaveBeenLastCalledWith(
			"us-1",
			expect.objectContaining({ owner: "pk-me", prefs: { absoluteTimestamps: false } }),
		);
	});
});

describe("ChatApp — pinned messages (Chats-4)", () => {
	function entitiesSvc(): { update: ReturnType<typeof vi.fn> } {
		return (
			window as unknown as {
				brainstorm: { services: { entities: { update: ReturnType<typeof vi.fn> } } };
			}
		).brainstorm.services.entities;
	}

	it("pins from the message menu onto the channel row and marks the message", async () => {
		const { openAnchoredMenu } = await import("@brainstorm-os/sdk/object-menu");
		const open = vi.mocked(openAnchoredMenu);
		await mount([channel("c1", "general"), message("m1", "c1", "Mira", "remember this")]);
		open.mockClear();
		act(() => {
			(container.querySelector(".chat__line-more") as HTMLButtonElement).click();
		});
		const item = open.mock.calls[0]?.[1][0];
		expect(item?.label).toBe("Pin message");
		await act(async () => item?.onSelect?.());
		expect(entitiesSvc().update).toHaveBeenCalledWith("c1", { pinned: ["m1"] });
		expect(container.querySelector('[data-message-id="m1"] .chat__line-pin')).not.toBeNull();

		open.mockClear();
		act(() => {
			container
				.querySelector('[data-message-id="m1"]')
				?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		});
		expect(open.mock.calls[0]?.[1][0]?.label).toBe("Unpin message");
	});

	it("lists a channel's pins from the header and jumps to one", async () => {
		const { openAnchoredMenu } = await import("@brainstorm-os/sdk/object-menu");
		const open = vi.mocked(openAnchoredMenu);
		const pinnedChannel = channel("c1", "general");
		pinnedChannel.properties.pinned = ["m1", "missing"];
		await mount([
			pinnedChannel,
			message("m1", "c1", "Mira", "the plan"),
			message("m2", "c1", "Ben", "x"),
		]);
		const btn = container.querySelector('[data-testid="pins-toggle"]') as HTMLButtonElement;
		expect(btn.getAttribute("aria-label")).toBe("1 pinned message");
		open.mockClear();
		act(() => btn.click());
		const items = open.mock.calls[0]?.[1] ?? [];
		expect(items.map((i) => i.label)).toEqual(["Mira: the plan"]);
		await act(async () => items[0]?.onSelect?.());
		expect(
			container.querySelector('[data-message-id="m1"]')?.classList.contains("chat__line-wrap--flash"),
		).toBe(true);
	});

	it("disables the pins button with no channel open (and says why)", async () => {
		await mount([]);
		const btn = container.querySelector('[data-testid="pins-toggle"]') as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
		expect(btn.title).toBe("Open a channel to see its pinned messages");
	});
});

describe("ChatApp — typing indicator over presence (Chats-4)", () => {
	function presenceShell(): {
		services: Record<string, unknown>;
		publish: ReturnType<typeof vi.fn>;
		push: (peers: { clientId: number; state: Record<string, unknown> }[]) => void;
	} {
		const publish = vi.fn(() => Promise.resolve());
		let cb: ((peers: { clientId: number; state: Record<string, unknown> }[]) => void) | null = null;
		return {
			publish,
			push: (peers) => cb?.(peers),
			services: {
				presence: { publish, untrack: vi.fn(() => Promise.resolve()) },
				roster: {
					self: vi.fn(() =>
						Promise.resolve({ pubkey: "pk-me", displayName: "Me", fingerprint: "ed25519:aa" }),
					),
					members: vi.fn(() => Promise.resolve([])),
				},
				__onPeers: (_id: string, c: typeof cb) => {
					cb = c;
					return () => {};
				},
			},
		};
	}

	async function mountWithPresence(): Promise<ReturnType<typeof presenceShell>> {
		const shell = presenceShell();
		installShell([channel("c1", "general")], undefined, shell.services);
		const bs = (window as unknown as { brainstorm: Record<string, unknown> }).brainstorm;
		bs.presence = { onPeers: shell.services.__onPeers };
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () => root.render(<ChatApp />));
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		return shell;
	}

	const lastActivity = (publish: ReturnType<typeof vi.fn>): unknown =>
		(
			publish.mock.calls[publish.mock.calls.length - 1]?.[0] as {
				state: { presence?: { activity?: string } } | null;
			}
		)?.state?.presence?.activity;

	it("publishes typing once per burst, clears it after the idle window, never writes an entity", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const shell = await mountWithPresence();
			expect(lastActivity(shell.publish)).toBeUndefined();
			typeComposer("h");
			expect(lastActivity(shell.publish)).toBe("typing");
			const afterFirst = shell.publish.mock.calls.length;
			typeComposer("he");
			typeComposer("hel");
			expect(shell.publish.mock.calls.length).toBe(afterFirst);
			await act(async () => {
				vi.advanceTimersByTime(4100);
			});
			expect(lastActivity(shell.publish)).toBeUndefined();
			expect(created.filter((c) => c.type !== USER_STATE_TYPE)).toHaveLength(0);
			expect(JSON.stringify(created)).not.toContain("typing");
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows who else is typing in the channel", async () => {
		const shell = await mountWithPresence();
		await act(async () => {
			shell.push([
				{
					clientId: 7,
					state: { presence: { id: "pk-ada", name: "Ada", color: "#000", activity: "typing" } },
				},
				{
					clientId: 8,
					state: { presence: { id: "pk-me", name: "Me", color: "#000", activity: "typing" } },
				},
			]);
		});
		expect(container.querySelector('[data-testid="typing"]')?.textContent).toBe("Ada is typing…");
		await act(async () => {
			shell.push([{ clientId: 7, state: { presence: { id: "pk-ada", name: "Ada", color: "#000" } } }]);
		});
		expect(container.querySelector('[data-testid="typing"]')?.textContent).toBe("");
	});
});
