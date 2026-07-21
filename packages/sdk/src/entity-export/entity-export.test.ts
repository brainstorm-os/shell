// @vitest-environment jsdom
import type { ExportTextFormat } from "@brainstorm-os/sdk-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SaveFileService } from "../export-file";
import { buildEntityExportItems, runEntityExport } from "./index";

const FILTER_BY_FORMAT: Record<ExportTextFormat, string> = {
	markdown: "Markdown",
	csv: "CSV",
	json: "JSON",
};
const LABELS = {
	filterName: (f: ExportTextFormat) => FILTER_BY_FORMAT[f],
	dialogTitle: "Export object",
	exportAction: "Export…",
	formatLegend: "Format",
	cancel: "Cancel",
};

function stubFiles(
	handle: { handleId: string; displayName: string } | null = { handleId: "h1", displayName: "out" },
) {
	const requestSaveCalls: unknown[] = [];
	const writes: Uint8Array[] = [];
	const files: SaveFileService = {
		requestSave: async (opts) => {
			requestSaveCalls.push(opts);
			return handle;
		},
		write: async (_handle, data) => {
			writes.push(data instanceof Uint8Array ? data : new Uint8Array(data));
		},
	};
	return { files, requestSaveCalls, writes };
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe("buildEntityExportItems", () => {
	afterEach(() => {
		for (const el of document.querySelectorAll(".bs-popover")) el.remove();
	});

	it("is a single 'Export…' object-menu row", () => {
		const { files } = stubFiles();
		const items = buildEntityExportItems({
			entityIds: ["e1"],
			files,
			serialize: async () => "",
			labels: LABELS,
		});
		expect(items).toHaveLength(1);
		expect(items[0]?.id).toBe("export");
		expect(items[0]?.label).toBe("Export…");
	});

	it("returns no row when there are no entities to export", () => {
		const { files } = stubFiles();
		const items = buildEntityExportItems({
			entityIds: [],
			files,
			serialize: async () => "",
			labels: LABELS,
		});
		expect(items).toHaveLength(0);
	});

	it("run() opens the export popover offering Markdown, CSV and JSON", () => {
		const { files } = stubFiles();
		const [item] = buildEntityExportItems({
			entityIds: ["e1"],
			files,
			serialize: async () => "",
			labels: LABELS,
		});
		item?.run();
		const text = document.querySelector(".bs-popover")?.textContent ?? "";
		expect(text).toContain("Markdown");
		expect(text).toContain("CSV");
		expect(text).toContain("JSON");
	});

	it("honours a narrowed format set", () => {
		const { files } = stubFiles();
		const [item] = buildEntityExportItems({
			entityIds: ["e1"],
			files,
			serialize: async () => "",
			labels: LABELS,
			formats: ["json"],
		});
		item?.run();
		const text = document.querySelector(".bs-popover")?.textContent ?? "";
		expect(text).toContain("JSON");
		expect(text).not.toContain("Markdown");
	});
});

describe("runEntityExport", () => {
	it("serialises the entity ids in the chosen format and writes the bytes", async () => {
		const { files, requestSaveCalls, writes } = stubFiles();
		const serialize = vi.fn(async () => "id,name\ne1,Phoenix\n");
		await runEntityExport("csv", {
			entityIds: ["e1"],
			name: "Project Phoenix",
			files,
			serialize,
			labels: LABELS,
		});
		expect(serialize).toHaveBeenCalledWith({ ids: ["e1"], format: "csv" });
		expect(requestSaveCalls[0]).toMatchObject({ suggestedName: "Project Phoenix.csv" });
		expect(decode(writes[0] as Uint8Array)).toBe("id,name\ne1,Phoenix\n");
	});

	it("defers serialisation until a save location is committed (cancel never serialises)", async () => {
		const { files } = stubFiles(null); // user cancels the save dialog
		const serialize = vi.fn(async () => "x");
		await runEntityExport("json", {
			entityIds: ["e1"],
			files,
			serialize,
			labels: LABELS,
		});
		expect(serialize).not.toHaveBeenCalled();
	});

	it("is a no-op (no save prompt) when there are no entities", async () => {
		const { files, requestSaveCalls } = stubFiles();
		const serialize = vi.fn(async () => "x");
		await runEntityExport("markdown", {
			entityIds: [],
			files,
			serialize,
			labels: LABELS,
		});
		expect(requestSaveCalls).toHaveLength(0);
		expect(serialize).not.toHaveBeenCalled();
	});

	it("reports the terminal disposition through onResult", async () => {
		const { files } = stubFiles();
		const dispositions: string[] = [];
		await runEntityExport("markdown", {
			entityIds: ["e1"],
			files,
			serialize: async () => "# Phoenix\n",
			labels: LABELS,
			onResult: (_f, d) => dispositions.push(d.kind),
		});
		expect(dispositions).toEqual(["saved"]);
	});
});
