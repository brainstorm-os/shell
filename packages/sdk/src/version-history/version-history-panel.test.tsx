// @vitest-environment jsdom
import {
	HistoryAccess,
	HistoryPrincipalKind,
	VersionCause,
	type VersionHistoryList,
	type VersionHistoryService,
	VersionPropertyChangeKind,
} from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type VersionHistoryLabels,
	VersionHistoryPanel,
	groupVersionsByDay,
} from "./version-history-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LABELS: VersionHistoryLabels = {
	title: "History",
	empty: "No earlier versions yet",
	emptyHint: "Versions appear a couple of minutes after you edit.",
	loadFailed: "Couldn't load history.",
	today: "Today",
	tomorrow: "Tomorrow",
	yesterday: "Yesterday",
	you: "You",
	causes: {
		[VersionCause.Idle]: "Edited",
		[VersionCause.BeforeBulk]: "Before a bulk change",
		[VersionCause.BeforeRestore]: "Before a restore",
		[VersionCause.AgentRun]: "Before an agent run",
		[VersionCause.Import]: "Before an import",
		[VersionCause.Manual]: "Saved",
	},
	listOnlyNotice: "You can see when this changed, not earlier content.",
	previewOnlyNotice: "You can't edit this object.",
	back: "All versions",
	changesHeading: "Property changes",
	noChanges: "Same properties as now",
	bodyHeading: "Content",
	emptyBody: "Empty",
	changeKinds: {
		[VersionPropertyChangeKind.Added]: "added since",
		[VersionPropertyChangeKind.Removed]: "removed since",
		[VersionPropertyChangeKind.Changed]: "changed",
	},
	restore: "Restore this version",
	restoring: "Restoring…",
	restoreFailed: "Couldn't restore.",
	restored: "Restored.",
	previewFailed: "Couldn't load this version.",
};

const NOW = new Date(2026, 9, 18, 15, 0).getTime();
const version = (id: string, at: number) => ({
	versionId: id,
	entityId: "e1",
	at,
	cause: VersionCause.Idle,
	changeSetId: null,
	principals: [{ kind: HistoryPrincipalKind.Member, id: "k", label: "k", isSelf: true }],
});

function service(list: VersionHistoryList) {
	return {
		list: vi.fn(async () => list),
		preview: vi.fn(async () => ({
			versionId: "v1",
			at: NOW,
			properties: { status: "todo" },
			changes: [
				{
					key: "status",
					kind: VersionPropertyChangeKind.Changed,
					versionValue: "todo",
					currentValue: "done",
				},
			],
			bodyText: "first draft",
		})),
		restore: vi.fn(async () => ({ beforeRestoreVersionId: "v9" })),
	} satisfies Pick<VersionHistoryService, "list" | "preview" | "restore">;
}

describe("<VersionHistoryPanel>", () => {
	let host: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});
	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	const render = async (svc: ReturnType<typeof service>) => {
		await act(async () => {
			root.render(<VersionHistoryPanel entityId="e1" service={svc} labels={LABELS} now={() => NOW} />);
		});
	};
	const click = async (el: Element | null | undefined) => {
		await act(async () => {
			(el as HTMLElement).click();
		});
	};

	it("is always live: an empty history shows its own empty state", async () => {
		await render(service({ access: HistoryAccess.Restore, versions: [] }));
		expect(host.textContent).toContain("No earlier versions yet");
	});

	it("groups by day and shows time, who and why", async () => {
		await render(
			service({
				access: HistoryAccess.Restore,
				versions: [version("v1", NOW - 60_000), version("v2", NOW - 26 * 3_600_000)],
			}),
		);
		const days = [...host.querySelectorAll(".bs-history__day-label")].map((n) => n.textContent);
		expect(days).toEqual(["Today", "Yesterday"]);
		expect(host.textContent).toContain("You");
		expect(host.textContent).toContain("Edited");
	});

	it("opens a read-only preview with the diff, and restores", async () => {
		const svc = service({ access: HistoryAccess.Restore, versions: [version("v1", NOW)] });
		await render(svc);
		await click(host.querySelector("button.bs-history__row"));
		expect(svc.preview).toHaveBeenCalledWith({ entityId: "e1", versionId: "v1" });
		expect(host.textContent).toContain("first draft");
		expect(host.textContent).toContain("status");
		const restore = host.querySelector<HTMLButtonElement>(".bs-history__restore");
		expect(restore?.textContent).toBe("Restore this version");
		await click(restore);
		expect(svc.restore).toHaveBeenCalledWith({ entityId: "e1", versionId: "v1" });
		expect(host.textContent).toContain("Restored.");
	});

	it("a Viewer gets the list only — rows are not openable and no preview is requested", async () => {
		const svc = service({ access: HistoryAccess.ListOnly, versions: [version("v1", NOW)] });
		await render(svc);
		expect(host.querySelector("button.bs-history__row")).toBeNull();
		expect(host.textContent).toContain("not earlier content");
		expect(svc.preview).not.toHaveBeenCalled();
	});

	it("preview-only access shows the diff but no restore button", async () => {
		const svc = service({ access: HistoryAccess.Preview, versions: [version("v1", NOW)] });
		await render(svc);
		await click(host.querySelector("button.bs-history__row"));
		expect(host.querySelector(".bs-history__restore")).toBeNull();
		expect(host.textContent).toContain("You can't edit this object.");
	});

	it("reports a load failure", async () => {
		const svc = service({ access: HistoryAccess.Restore, versions: [] });
		svc.list.mockRejectedValueOnce(new Error("nope"));
		await render(svc);
		expect(host.querySelector('[role="alert"]')?.textContent).toBe("Couldn't load history.");
	});
});

describe("groupVersionsByDay", () => {
	it("keeps newest-first order inside a calendar day", () => {
		const groups = groupVersionsByDay(
			[version("a", NOW - 1_000), version("b", NOW - 2_000)],
			NOW,
			LABELS,
		);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.versions.map((v) => v.versionId)).toEqual(["a", "b"]);
	});
});
