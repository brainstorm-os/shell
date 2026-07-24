// @vitest-environment jsdom
/**
 * Agent chrome smoke test — the header carries the object ⋯ menu LAST in
 * `.app-header__right` (the cross-app contract): disabled with no active
 * conversation, live once one exists.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentApp, unavailableMessage } from "./app";
import { flush, renderInto } from "./test/render";

describe("unavailableMessage (F-259 provider-aware guidance)", () => {
	it("points the local model at `ollama serve`", () => {
		const msg = unavailableMessage("ollama");
		expect(msg).toContain("ollama serve");
		expect(msg).not.toContain("API key");
	});

	it("points a cloud provider at its API key, named", () => {
		const msg = unavailableMessage("anthropic");
		expect(msg).toContain("API key");
		expect(msg).toContain("Anthropic Claude");
		expect(msg).not.toContain("ollama serve");
	});

	it("gives general setup guidance for AUTO (no pinned provider)", () => {
		const msg = unavailableMessage(undefined);
		expect(msg).toContain("No AI model could be reached");
		expect(msg).not.toContain("ollama serve");
	});

	it("falls back to the bare id for an unknown cloud provider", () => {
		const msg = unavailableMessage("mystery");
		expect(msg).toContain("mystery");
		expect(msg).toContain("API key");
	});
});

let handle: Awaited<ReturnType<typeof renderInto>> | null = null;

beforeEach(() => {
	// jsdom has no scrollIntoView; the transcript auto-scroll calls it.
	Element.prototype.scrollIntoView = vi.fn();
});

afterEach(async () => {
	await handle?.unmount();
	handle = null;
	window.brainstorm = undefined;
});

function installShell(conversations: Array<{ id: string; title: string }>): void {
	const snapshot = {
		entities: conversations.map((c) => ({
			id: c.id,
			type: "brainstorm/Conversation/v1",
			properties: { title: c.title },
			createdAt: 1,
			updatedAt: 1,
			deletedAt: null,
			ownerAppId: "io.brainstorm.agent",
		})),
		links: [],
	};
	window.brainstorm = {
		capabilities: [],
		services: {
			vaultEntities: {
				list: async () => snapshot,
				onChange: () => ({ unsubscribe: () => undefined }),
			},
		},
	} as unknown as typeof window.brainstorm;
}

describe("AgentApp header", () => {
	it("standalone: the ⋯ is the LAST element of .app-header__right and disabled (no conversation)", async () => {
		handle = await renderInto(<AgentApp />);
		await flush();
		const right = handle.container.querySelector<HTMLElement>(".app-header__right");
		expect(right).not.toBeNull();
		const last = right?.lastElementChild as HTMLButtonElement;
		expect(last.classList.contains("bs-object-menu__more")).toBe(true);
		// F-271: the unavailable ⋯ uses aria-disabled (NOT native `disabled`) so it
		// stays hoverable/focusable for its explanatory tooltip.
		expect(last.disabled).toBe(false);
		expect(last.getAttribute("aria-disabled")).toBe("true");
		// New chat stays first — content action before the ⋯.
		expect(right?.firstElementChild?.getAttribute("aria-label")).toBe("New chat");
	});

	it("with an active conversation the ⋯ is enabled and still LAST", async () => {
		installShell([{ id: "conv_1", title: "Renewals" }]);
		handle = await renderInto(<AgentApp />);
		await flush();
		await flush();
		const right = handle.container.querySelector<HTMLElement>(".app-header__right");
		const last = right?.lastElementChild as HTMLButtonElement;
		expect(last.classList.contains("bs-object-menu__more")).toBe(true);
		expect(last.disabled).toBe(false);
		expect(handle.container.querySelector(".app-header__title")?.textContent).toBe("Renewals");
	});
});

describe("AgentApp composer context", () => {
	function installWithMessage(): void {
		const snapshot = {
			entities: [
				{
					id: "conv_1",
					type: "brainstorm/Conversation/v1",
					properties: { title: "Renewals" },
					createdAt: 1,
					updatedAt: 1,
					deletedAt: null,
					ownerAppId: "io.brainstorm.agent",
				},
				{
					id: "msg_1",
					type: "brainstorm/Message/v1",
					properties: {
						conversation: "conv_1",
						role: "user",
						body: "what does this say?",
						createdAt: "2026-06-20T00:00:00.000Z",
						seq: 0,
						attachments: [
							{ kind: "entity", ref: "ent_1", label: "Q3 Spec", entityType: "brainstorm/Note/v1" },
						],
					},
					createdAt: 2,
					updatedAt: 2,
					deletedAt: null,
					ownerAppId: "io.brainstorm.agent",
				},
			],
			links: [],
		};
		window.brainstorm = {
			capabilities: ["entities.read:*"],
			services: {
				vaultEntities: {
					list: async () => snapshot,
					onChange: () => ({ unsubscribe: () => undefined }),
				},
			},
		} as unknown as typeof window.brainstorm;
	}

	it("renders the add-context button in the composer", async () => {
		installShell([{ id: "conv_1", title: "Renewals" }]);
		handle = await renderInto(<AgentApp />);
		await flush();
		await flush();
		const attach = handle.container.querySelector(".bs-composer-context__attach");
		expect(attach).not.toBeNull();
		expect(attach?.getAttribute("aria-label")).toBe("Add context");
	});

	it("renders attachment chips on a persisted user turn, labelled and clickable", async () => {
		installWithMessage();
		handle = await renderInto(<AgentApp />);
		await flush();
		await flush();
		const rail = handle.container.querySelector('[data-testid="agent-attachments"]');
		expect(rail).not.toBeNull();
		const chip = rail?.querySelector(".agent__attachment--link") as HTMLButtonElement;
		expect(chip).not.toBeNull();
		expect(chip.textContent).toContain("Q3 Spec");
		expect(chip.getAttribute("data-bs-tooltip")).toBe("Open Q3 Spec");
		expect(chip.getAttribute("aria-label")).toBe("Open Q3 Spec");
	});
});

describe("AgentApp stored transcript rendering (F-319)", () => {
	const STORED_BODY = [
		"Based on your notes, here is a summary:",
		"",
		"### Summary of Northbound Q3 Plan",
		"",
		"1. **Documents:**",
		"   - [n_abc123] Northbound Q3 plan 32834",
		"   - [n_def456] Northbound Q3 plan 21788",
		"",
		"If you need more, let me know!",
	].join("\n");

	function installWithAssistantMessage(): void {
		const snapshot = {
			entities: [
				{
					id: "conv_1",
					type: "brainstorm/Conversation/v1",
					properties: { title: "Northbound Q3" },
					createdAt: 1,
					updatedAt: 1,
					deletedAt: null,
					ownerAppId: "io.brainstorm.agent",
				},
				{
					id: "msg_1",
					type: "brainstorm/Message/v1",
					properties: {
						conversation: "conv_1",
						role: "assistant",
						body: STORED_BODY,
						createdAt: "2026-06-30T00:00:00.000Z",
						seq: 1,
					},
					createdAt: 2,
					updatedAt: 2,
					deletedAt: null,
					ownerAppId: "io.brainstorm.agent",
				},
			],
			links: [],
		};
		window.brainstorm = {
			capabilities: ["entities.read:*"],
			services: {
				vaultEntities: {
					list: async () => snapshot,
					onChange: () => ({ unsubscribe: () => undefined }),
				},
			},
		} as unknown as typeof window.brainstorm;
	}

	it("renders a stored assistant message as formatted markdown, not raw source", async () => {
		installWithAssistantMessage();
		handle = await renderInto(<AgentApp />);
		await flush();
		await flush();
		const body = handle.container.querySelector(".agent__msg--assistant .agent__msg-body");
		expect(body).not.toBeNull();
		// Formatted DOM: a real heading + real bold, never the raw markers.
		expect(body?.querySelector("h3")?.textContent).toBe("Summary of Northbound Q3 Plan");
		expect(body?.textContent).not.toContain("###");
		const bolds = Array.from(body?.querySelectorAll("strong") ?? []).map((b) => b.textContent);
		expect(bolds).toContain("Documents:");
		expect(body?.textContent).not.toContain("**");
	});

	it("Agent-9: 'Draft as email' dispatches the compose intent with the reply body", async () => {
		installWithAssistantMessage();
		const dispatch = vi.fn((_envelope: unknown) => Promise.resolve(null));
		const services = (window.brainstorm as NonNullable<typeof window.brainstorm>).services as Record<
			string,
			unknown
		>;
		services.intents = { dispatch };
		handle = await renderInto(<AgentApp />);
		await flush();
		await flush();
		const button = handle.container.querySelector<HTMLButtonElement>(
			'[data-testid="agent-draft-email"]',
		);
		expect(button).not.toBeNull();
		button?.click();
		await flush();
		expect(dispatch).toHaveBeenCalledTimes(1);
		const envelope = dispatch.mock.calls[0]?.[0] as { verb: string; payload: { body: string } };
		expect(envelope.verb).toBe("compose");
		expect(envelope.payload.body).toContain("Summary of Northbound Q3 Plan");
	});

	it("Agent-9: no 'Draft as email' button when the intents service is absent", async () => {
		installWithAssistantMessage();
		handle = await renderInto(<AgentApp />);
		await flush();
		await flush();
		expect(handle.container.querySelector('[data-testid="agent-draft-email"]')).toBeNull();
	});

	it("renders `[n_…] Title` citations as entity links, never the raw node id", async () => {
		installWithAssistantMessage();
		handle = await renderInto(<AgentApp />);
		await flush();
		await flush();
		const body = handle.container.querySelector(".agent__msg--assistant .agent__msg-body");
		expect(body).not.toBeNull();
		expect(body?.textContent).not.toContain("[n_abc123]");
		expect(body?.textContent).not.toContain("n_abc123");
		const links = Array.from(body?.querySelectorAll(".bs-markdown__entity-link") ?? []).map(
			(l) => l.textContent,
		);
		expect(links).toContain("Northbound Q3 plan 32834");
		expect(links).toContain("Northbound Q3 plan 21788");
	});
});

describe("AgentApp created-object back-links (Agent-11c)", () => {
	function installWithCreatedObject(): { dispatch: ReturnType<typeof vi.fn> } {
		const dispatch = vi.fn((_envelope: unknown) => Promise.resolve(null));
		const snapshot = {
			entities: [
				{
					id: "conv_1",
					type: "brainstorm/Conversation/v1",
					properties: { title: "Trip planning" },
					createdAt: 1,
					updatedAt: 1,
					deletedAt: null,
					ownerAppId: "io.brainstorm.agent",
				},
				{
					// A note the agent created in conv_1 (server-stamped provenance).
					id: "note_1",
					type: "io.brainstorm.notes/Note/v1",
					properties: {
						title: "Packing list",
						agentProvenance: {
							agent: "io.brainstorm.agent",
							conversationId: "conv_1",
							createdAt: 5,
						},
					},
					createdAt: 5,
					updatedAt: 5,
					deletedAt: null,
					ownerAppId: "io.brainstorm.notes",
				},
				{
					// A note created in a DIFFERENT conversation — must NOT surface.
					id: "note_2",
					type: "io.brainstorm.notes/Note/v1",
					properties: {
						title: "Other chat note",
						agentProvenance: {
							agent: "io.brainstorm.agent",
							conversationId: "conv_other",
							createdAt: 6,
						},
					},
					createdAt: 6,
					updatedAt: 6,
					deletedAt: null,
					ownerAppId: "io.brainstorm.notes",
				},
			],
			links: [],
		};
		window.brainstorm = {
			capabilities: ["entities.read:*"],
			services: {
				vaultEntities: {
					list: async () => snapshot,
					onChange: () => ({ unsubscribe: () => undefined }),
				},
				intents: { dispatch },
			},
		} as unknown as typeof window.brainstorm;
		return { dispatch };
	}

	it("renders a chip for the object created in the active conversation, and only that one", async () => {
		installWithCreatedObject();
		handle = await renderInto(<AgentApp />);
		await flush();
		await flush();
		const chips = Array.from(
			handle.container.querySelectorAll('[data-testid="agent-created-chip"]'),
		).map((c) => c.textContent);
		expect(chips).toEqual(["Packing list"]);
	});

	it("clicking a created chip opens the entity via the cap-checked open intent", async () => {
		const { dispatch } = installWithCreatedObject();
		handle = await renderInto(<AgentApp />);
		await flush();
		await flush();
		const chip = handle.container.querySelector<HTMLButtonElement>(
			'[data-testid="agent-created-chip"]',
		);
		expect(chip).not.toBeNull();
		chip?.click();
		await flush();
		const openCall = dispatch.mock.calls
			.map((c) => c[0] as { verb: string; payload: { entityId?: string } })
			.find((e) => e.verb === "open");
		expect(openCall).toBeTruthy();
		expect(openCall?.payload.entityId).toBe("note_1");
	});
});
