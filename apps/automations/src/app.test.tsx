import {
	REMINDER_TYPE_URL,
	WORKFLOW_RUN_TYPE_URL,
	WORKFLOW_TYPE_URL,
} from "@brainstorm-os/sdk-types";
import { openAnchoredMenu } from "@brainstorm-os/sdk/object-menu";
// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationsApp } from "./app";
import { flush, renderInto } from "./test/render";

vi.mock("@brainstorm-os/sdk/menus", () => ({
	mountMenuHost: vi.fn(),
	MenuAlign: { Start: "start", End: "end" },
}));
vi.mock("@brainstorm-os/sdk/object-menu", () => ({
	openAnchoredMenu: vi.fn(),
}));

afterEach(() => {
	vi.mocked(openAnchoredMenu).mockClear();
	(window as { brainstorm?: unknown }).brainstorm = undefined;
});

type SnapshotEntity = { id: string; type: string; properties: Record<string, unknown> };

type ReadyHandler = () => void;

/** A minimal in-shell stub: fires `ready` so the live lists bind, exposes a
 *  `vaultEntities` whose snapshot the three views derive from, and an
 *  `entities` service whose writes are recorded. */
type HostState = { deviceId: string; hostDeviceId: string | null; scheduling: boolean };

function installShell(
	entities: SnapshotEntity[],
	host?: HostState,
): {
	fireReady(): void;
	writes: Array<{ op: string; args: unknown[] }>;
	runNowCalls: Array<{ workflowId: string }>;
	hostStatusCalls: number;
	claimCalls: number;
} {
	const readyHandlers: ReadyHandler[] = [];
	const writes: Array<{ op: string; args: unknown[] }> = [];
	const runNowCalls: Array<{ workflowId: string }> = [];
	let hostStatusCalls = 0;
	let claimCalls = 0;
	const hostState: HostState = host ?? { deviceId: "d", hostDeviceId: null, scheduling: false };
	const snapshot = {
		entities: entities.map((e) => ({
			id: e.id,
			type: e.type,
			properties: e.properties,
			createdAt: 1,
			updatedAt: 1,
			deletedAt: null,
			ownerAppId: "io.brainstorm.automations",
		})),
		links: [],
	};
	(window as { brainstorm?: unknown }).brainstorm = {
		services: {
			entities: {
				get: async (id: string) => snapshot.entities.find((e) => e.id === id) ?? null,
				query: async () => [],
				create: async (...args: unknown[]) => {
					writes.push({ op: "create", args });
					return { id: "new", type: "", properties: {}, createdAt: 0, updatedAt: 0 };
				},
				update: async (...args: unknown[]) => {
					writes.push({ op: "update", args });
					return { id: "x", type: "", properties: {}, createdAt: 0, updatedAt: 0 };
				},
				delete: async (...args: unknown[]) => {
					writes.push({ op: "delete", args });
				},
			},
			vaultEntities: {
				list: async () => snapshot,
				queryPattern: async () => ({ ok: true, snapshot }),
				onChange: () => ({ unsubscribe: () => undefined }),
			},
			automations: {
				runNow: async (input: { workflowId: string }) => {
					runNowCalls.push(input);
					return { status: "succeeded" };
				},
				hostStatus: async () => {
					hostStatusCalls += 1;
					return { ...hostState };
				},
				claimHost: async () => {
					claimCalls += 1;
					hostState.hostDeviceId = hostState.deviceId;
					hostState.scheduling = true;
					return { ...hostState };
				},
			},
		},
		on: (event: string, handler: ReadyHandler) => {
			if (event === "ready") readyHandlers.push(handler);
			return { unsubscribe: () => undefined };
		},
	};
	return {
		fireReady: () => {
			for (const h of readyHandlers) h();
		},
		writes,
		runNowCalls,
		get hostStatusCalls() {
			return hostStatusCalls;
		},
		get claimCalls() {
			return claimCalls;
		},
	};
}

function workflow(id: string, name: string, enabled: boolean): SnapshotEntity {
	return {
		id,
		type: WORKFLOW_TYPE_URL,
		properties: { name, enabled, triggerId: "t1", steps: [], capabilities: [] },
	};
}

describe("AutomationsApp", () => {
	it("renders the app-header with NO trailing object ⋯ (no header object to act on)", async () => {
		const { container, unmount } = await renderInto(<AutomationsApp />);
		await flush();
		const header = container.querySelector('[data-testid="app-header"]');
		expect(header?.classList.contains("app-header")).toBe(true);
		expect(container.querySelector(".app-header__title")?.textContent).toBe("Automations");
		const right = container.querySelector<HTMLElement>(".app-header__right");
		expect(right).toBeTruthy();
		// A permanently-disabled ⋯ reads as broken, so the header right group
		// has no object menu at all rather than a dead button.
		expect(right?.querySelector(".bs-object-menu__more")).toBeNull();
		expect(right?.children.length).toBe(0);
		await unmount();
	});

	it("renders the three view tabs as a tablist and switches the active pane", async () => {
		const { container, unmount } = await renderInto(<AutomationsApp />);
		await flush();
		const tablist = container.querySelector('[role="tablist"]');
		expect(tablist).toBeTruthy();
		const tabs = container.querySelectorAll<HTMLButtonElement>(".au-tab");
		expect(tabs).toHaveLength(3);
		expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
		expect(tabs[0]?.tabIndex).toBe(0);
		expect(tabs[1]?.tabIndex).toBe(-1);
		// Switching to Reminders shows the capture form.
		await act(async () => {
			tabs[1]?.click();
		});
		expect(container.querySelector(".au-capture")).toBeTruthy();
		await unmount();
	});

	it("ArrowRight moves focus and Enter commits the view (no raw e.key in chrome)", async () => {
		const { container, unmount } = await renderInto(<AutomationsApp />);
		await flush();
		const tabs = container.querySelectorAll<HTMLButtonElement>(".au-tab");
		await act(async () => {
			tabs[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		});
		// Focus moved to the Runs… actually Reminders tab; commit it with Enter.
		await act(async () => {
			document.activeElement?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
		});
		const after = container.querySelectorAll<HTMLButtonElement>(".au-tab");
		expect(after[1]?.getAttribute("aria-selected")).toBe("true");
		await unmount();
	});

	it("uses no native <select> anywhere — the recurrence picker is a menu button", async () => {
		const { container, unmount } = await renderInto(<AutomationsApp />);
		await flush();
		const tabs = container.querySelectorAll<HTMLButtonElement>(".au-tab");
		await act(async () => {
			tabs[1]?.click(); // Reminders
		});
		expect(container.querySelector("select")).toBeNull();
		await act(async () => {
			container.querySelector<HTMLButtonElement>(".au-capture__repeat")?.click();
		});
		expect(openAnchoredMenu).toHaveBeenCalled();
		await unmount();
	});

	it("shows the template gallery as the empty workflows state (F-280)", async () => {
		const { container, unmount } = await renderInto(<AutomationsApp />);
		await flush();
		// No workflows → the gallery IS the empty state (actionable), so its
		// "Start from a template" title + template cards render and the bare
		// "…below" placeholder is gone.
		const gallery = container.querySelector(".au-templates");
		expect(gallery).toBeTruthy();
		expect(gallery?.querySelector(".au-templates__title")?.textContent).toBe("Start from a template");
		expect(container.querySelectorAll(".au-template").length).toBeGreaterThan(0);
		// With nothing to dismiss back to, the gallery hides its Cancel.
		expect(gallery?.querySelector(".au-templates__head .bs-btn")).toBeNull();
		await unmount();
	});

	it("derives the workflows list from the live vault snapshot (the ONE stack)", async () => {
		const shell = installShell([
			workflow("wf-1", "Daily digest", true),
			workflow("wf-2", "Weekly report", false),
			{ id: "n1", type: "brainstorm/Note/v1", properties: { name: "ignore" } },
		]);
		const { container, unmount } = await renderInto(<AutomationsApp />);
		await act(async () => {
			shell.fireReady();
		});
		await flush();
		await flush();
		await flush();
		const rows = container.querySelectorAll(".au-list .au-row");
		expect(rows).toHaveLength(2);
		expect(rows[0]?.querySelector(".au-row__name")?.textContent).toBe("Daily digest");
		expect(rows[0]?.querySelector(".au-row__status")?.textContent).toBe("Enabled");
		expect(rows[1]?.querySelector(".au-row__status")?.textContent).toBe("Disabled");
		await unmount();
	});

	it("opens a per-row ⋯ menu through fancy-menus (shared object-menu chrome)", async () => {
		const shell = installShell([workflow("wf-1", "Daily digest", true)]);
		const { container, unmount } = await renderInto(<AutomationsApp />);
		await act(async () => {
			shell.fireReady();
		});
		await flush();
		await flush();
		const more = container.querySelector<HTMLButtonElement>(".au-row__more");
		expect(more?.classList.contains("bs-object-menu__more")).toBe(true);
		await act(async () => {
			more?.click();
		});
		expect(openAnchoredMenu).toHaveBeenCalled();
		const [, items] = vi.mocked(openAnchoredMenu).mock.calls.at(-1) ?? [];
		const labels = (items as Array<{ label: string }>).map((i) => i.label);
		expect(labels).toContain("Disable");
		expect(labels).toContain("Copy bundle");
		await unmount();
	});

	it("Run now in the row menu calls the shell automations service (11b.6)", async () => {
		const shell = installShell([workflow("wf-1", "Daily digest", true)]);
		const { container, unmount } = await renderInto(<AutomationsApp />);
		await act(async () => {
			shell.fireReady();
		});
		await flush();
		await flush();
		const more = container.querySelector<HTMLButtonElement>(".au-row__more");
		await act(async () => {
			more?.click();
		});
		const [, items] = vi.mocked(openAnchoredMenu).mock.calls.at(-1) ?? [];
		const runItem = (items as Array<{ label: string; onSelect: () => void }>).find(
			(i) => i.label === "Run now",
		);
		expect(runItem).toBeDefined();
		await act(async () => {
			runItem?.onSelect();
		});
		await flush();
		expect(shell.runNowCalls).toEqual([{ workflowId: "wf-1" }]);
		await unmount();
	});

	it("renders the reminders list from the snapshot with a status pill", async () => {
		const shell = installShell([
			{
				id: "rm-1",
				type: REMINDER_TYPE_URL,
				properties: { subject: "Stand-up", dueAt: "2000-01-01T09:00:00.000Z" },
			},
		]);
		const { container, unmount } = await renderInto(<AutomationsApp />);
		await act(async () => {
			shell.fireReady();
		});
		await flush();
		await flush();
		await act(async () => {
			container.querySelectorAll<HTMLButtonElement>(".au-tab")[1]?.click();
		});
		const rows = container.querySelectorAll(".au-list .au-row");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.querySelector(".au-row__name")?.textContent).toBe("Stand-up");
		// A past one-shot reminder reads as Overdue.
		expect(rows[0]?.querySelector(".au-pill")?.textContent).toBe("Overdue");
		await unmount();
	});

	it("renders the runs view + inspector from WorkflowRun/v1 snapshot rows", async () => {
		const shell = installShell([
			workflow("wf-1", "Daily digest", true),
			{
				id: "run-1",
				type: WORKFLOW_RUN_TYPE_URL,
				properties: {
					workflow: "wf-1",
					status: "succeeded",
					triggeredAt: "2026-01-01T09:00:00.000Z",
					stepLog: [{ stepId: "s1", kind: "notify", status: "succeeded", depth: 0 }],
				},
			},
		]);
		const { container, unmount } = await renderInto(<AutomationsApp />);
		await act(async () => {
			shell.fireReady();
		});
		await flush();
		await flush();
		await act(async () => {
			container.querySelectorAll<HTMLButtonElement>(".au-tab")[2]?.click();
		});
		const runs = container.querySelectorAll(".au-runs .au-run");
		expect(runs).toHaveLength(1);
		expect(runs[0]?.querySelector(".au-row__name")?.textContent).toBe("Daily digest");
		// Inspect expands the step log.
		await act(async () => {
			runs[0]?.querySelector<HTMLButtonElement>(".bs-btn--ghost")?.click();
		});
		expect(container.querySelector(".au-steps .au-step")).toBeTruthy();
		await unmount();
	});

	it("shows the host-status row labelling THIS device as the automation host (no Claim)", async () => {
		const shell = installShell([workflow("wf-1", "Daily digest", true)], {
			deviceId: "d",
			hostDeviceId: "d",
			scheduling: true,
		});
		const { container, unmount } = await renderInto(<AutomationsApp />);
		await act(async () => {
			shell.fireReady();
		});
		await flush();
		await flush();
		const row = container.querySelector('[data-testid="host-status"]');
		expect(row).toBeTruthy();
		expect(row?.classList.contains("au-host--self")).toBe(true);
		expect(row?.querySelector(".au-host__label")?.textContent).toBe("Schedules run on this device.");
		// THIS device hosts — no Claim affordance.
		expect(row?.querySelector(".au-host__claim")).toBeNull();
		await unmount();
	});

	it("offers a Claim button when no device hosts and refreshes status on claim", async () => {
		const shell = installShell([workflow("wf-1", "Daily digest", true)], {
			deviceId: "d",
			hostDeviceId: null,
			scheduling: false,
		});
		const { container, unmount } = await renderInto(<AutomationsApp />);
		await act(async () => {
			shell.fireReady();
		});
		await flush();
		await flush();
		const row = container.querySelector('[data-testid="host-status"]');
		expect(row?.querySelector(".au-host__label")?.textContent).toBe(
			"Schedules need one of your devices to run on.",
		);
		const claim = row?.querySelector<HTMLButtonElement>(".au-host__claim");
		expect(claim).toBeTruthy();
		expect(claim?.textContent).toBe("Use this device");
		expect(shell.claimCalls).toBe(0);
		await act(async () => {
			claim?.click();
		});
		await flush();
		await flush();
		expect(shell.claimCalls).toBe(1);
		// Status re-read after the claim: this device now hosts, Claim is gone.
		const after = container.querySelector('[data-testid="host-status"]');
		expect(after?.classList.contains("au-host--self")).toBe(true);
		expect(after?.querySelector(".au-host__label")?.textContent).toBe(
			"Schedules run on this device.",
		);
		expect(after?.querySelector(".au-host__claim")).toBeNull();
		await unmount();
	});

	it("labels another device as host and offers a Claim (take-over)", async () => {
		const shell = installShell([], {
			deviceId: "d",
			hostDeviceId: "other-device",
			scheduling: false,
		});
		const { container, unmount } = await renderInto(<AutomationsApp />);
		await act(async () => {
			shell.fireReady();
		});
		await flush();
		await flush();
		const row = container.querySelector('[data-testid="host-status"]');
		expect(row?.classList.contains("au-host--other")).toBe(true);
		expect(row?.querySelector(".au-host__label")?.textContent).toBe(
			"Schedules run on another device.",
		);
		expect(row?.querySelector(".au-host__claim")).toBeTruthy();
		await unmount();
	});

	it("hides the host-status row outside the shell (no automations service)", async () => {
		const { container, unmount } = await renderInto(<AutomationsApp />);
		await flush();
		expect(container.querySelector('[data-testid="host-status"]')).toBeNull();
		await unmount();
	});

	it("fills the height: the body lives under the fixed app-header", async () => {
		const { container, unmount } = await renderInto(<AutomationsApp />);
		await flush();
		expect(container.querySelector("#app-root")).toBeTruthy();
		expect(container.querySelector(".au-body")).toBeTruthy();
		await unmount();
	});
});
