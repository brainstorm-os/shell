// @vitest-environment jsdom
import {
	RecurrenceKind,
	StepKind,
	type TriggerDef,
	TriggerKind,
	type WorkflowDef,
	type WorkflowStep,
	aggregateWorkflowCapabilities,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import type { LoadedWorkflow } from "../storage/automation-repository";
import type {
	AutomationFileHandle,
	EntitiesService,
	EntityRecord,
	FilesService,
} from "../storage/runtime";
import { exportAutomation, serializeAutomationBundle } from "./transfer";
import {
	ExportOutcome,
	ImportOutcome,
	exportWorkflowToClipboard,
	exportWorkflowToFile,
	importWorkflowFromFile,
} from "./transfer-actions";

const STEPS: WorkflowStep[] = [
	{ id: "trigger", kind: StepKind.Trigger },
	{ id: "ping", kind: StepKind.Notify, title: "Hi", body: "There" },
];

const TRIGGER: TriggerDef = {
	kind: TriggerKind.Time,
	config: { recurrence: { kind: RecurrenceKind.Daily, every: 1 } },
	enabled: true,
};

const WORKFLOW: WorkflowDef = {
	name: "Daily ping",
	enabled: true,
	triggerId: "trg_1",
	steps: STEPS,
	capabilities: aggregateWorkflowCapabilities(STEPS),
};

const LOADED: LoadedWorkflow = { id: "wf_1", def: WORKFLOW };

const LABELS = { dialogTitle: "Title", filterName: "Bundle" };

function record(id: string, type: string, properties: Record<string, unknown>): EntityRecord {
	return { id, type, properties, createdAt: 0, updatedAt: 0 };
}

/** Entities stub that resolves the workflow's trigger by id. */
function entitiesWithTrigger(trigger: TriggerDef | null): EntitiesService {
	const created: EntityRecord[] = [];
	return {
		get: async (id) =>
			id === WORKFLOW.triggerId && trigger
				? record(id, "brainstorm/Trigger/v1", {
						kind: trigger.kind,
						config: trigger.config,
						enabled: trigger.enabled,
					})
				: null,
		query: async () => [],
		create: async (type, properties, id) => {
			const rec = record(id ?? `new_${created.length}`, type, properties);
			created.push(rec);
			return rec;
		},
		update: async (id, patch) => record(id, "x", patch),
		delete: async () => undefined,
	};
}

function filesStub(over: Partial<FilesService>): FilesService {
	return {
		requestOpen: async () => [],
		requestSave: async () => null,
		read: async () => new Uint8Array(),
		write: async () => undefined,
		...over,
	};
}

describe("exportWorkflowToFile", () => {
	it("saves the serialized bundle through the Files host", async () => {
		const handle: AutomationFileHandle = { handleId: "h", displayName: "Daily ping.json" };
		let written: Uint8Array | undefined;
		const files = filesStub({
			requestSave: async () => handle,
			write: async (_h, data) => {
				written = data as Uint8Array;
			},
		});
		const result = await exportWorkflowToFile(entitiesWithTrigger(TRIGGER), files, LOADED, LABELS);
		expect(result.outcome).toBe(ExportOutcome.Saved);
		const text = new TextDecoder().decode(written);
		expect(JSON.parse(text).workflow.name).toBe("Daily ping");
	});

	it("reports MissingTrigger when the binding can't be resolved", async () => {
		const result = await exportWorkflowToFile(
			entitiesWithTrigger(null),
			filesStub({}),
			LOADED,
			LABELS,
		);
		expect(result.outcome).toBe(ExportOutcome.MissingTrigger);
	});

	it("maps a cancelled save dialog to Cancelled", async () => {
		const result = await exportWorkflowToFile(
			entitiesWithTrigger(TRIGGER),
			filesStub({ requestSave: async () => null }),
			LOADED,
			LABELS,
		);
		expect(result.outcome).toBe(ExportOutcome.Cancelled);
	});

	it("maps a write failure to Failed", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const result = await exportWorkflowToFile(
			entitiesWithTrigger(TRIGGER),
			filesStub({
				requestSave: async () => ({ handleId: "h", displayName: "x.json" }),
				write: async () => {
					throw new Error("disk full");
				},
			}),
			LOADED,
			LABELS,
		);
		expect(result.outcome).toBe(ExportOutcome.Failed);
		warn.mockRestore();
	});
});

describe("exportWorkflowToClipboard", () => {
	it("writes the bundle JSON to the clipboard", async () => {
		let copied = "";
		const result = await exportWorkflowToClipboard(entitiesWithTrigger(TRIGGER), LOADED, {
			writeText: async (text) => {
				copied = text;
			},
		});
		expect(result.outcome).toBe(ExportOutcome.Copied);
		expect(JSON.parse(copied).trigger.kind).toBe(TriggerKind.Time);
	});

	it("maps a clipboard rejection to Failed", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const result = await exportWorkflowToClipboard(entitiesWithTrigger(TRIGGER), LOADED, {
			writeText: async () => {
				throw new Error("denied");
			},
		});
		expect(result.outcome).toBe(ExportOutcome.Failed);
		warn.mockRestore();
	});
});

describe("importWorkflowFromFile", () => {
	function bundleBytes(): Uint8Array {
		return new TextEncoder().encode(serializeAutomationBundle(exportAutomation(WORKFLOW, TRIGGER)));
	}

	it("parses a bundle and mints a disabled trigger+workflow pair", async () => {
		const created: { type: string; props: Record<string, unknown> }[] = [];
		const entities: EntitiesService = {
			get: async () => null,
			query: async () => [],
			create: async (type, props, id) => {
				created.push({ type, props });
				return record(id ?? `new_${created.length}`, type, props);
			},
			update: async (id) => record(id, "x", {}),
			delete: async () => undefined,
		};
		const files = filesStub({
			requestOpen: async () => [{ handleId: "h", displayName: "b.json" }],
			read: async () => bundleBytes(),
		});
		const result = await importWorkflowFromFile(entities, files, ["Daily ping"], LABELS);
		expect(result.outcome).toBe(ImportOutcome.Imported);
		if (result.outcome === ImportOutcome.Imported) expect(result.name).toBe("Daily ping (2)");
		const workflow = created.find((c) => c.type === "brainstorm/Workflow/v1");
		expect(workflow?.props.enabled).toBe(false);
		expect(workflow?.props.name).toBe("Daily ping (2)");
	});

	it("returns the structured issues for a malformed bundle", async () => {
		const files = filesStub({
			requestOpen: async () => [{ handleId: "h", displayName: "b.json" }],
			read: async () => new TextEncoder().encode("not json"),
		});
		const result = await importWorkflowFromFile(entities0(), files, [], LABELS);
		expect(result.outcome).toBe(ImportOutcome.Invalid);
		if (result.outcome === ImportOutcome.Invalid) expect(result.issues.length).toBeGreaterThan(0);
	});

	it("maps a cancelled open dialog to Cancelled", async () => {
		const result = await importWorkflowFromFile(
			entities0(),
			filesStub({ requestOpen: async () => [] }),
			[],
			LABELS,
		);
		expect(result.outcome).toBe(ImportOutcome.Cancelled);
	});
});

function entities0(): EntitiesService {
	return {
		get: async () => null,
		query: async () => [],
		create: async (type, props, id) => record(id ?? "x", type, props),
		update: async (id) => record(id, "x", {}),
		delete: async () => undefined,
	};
}
