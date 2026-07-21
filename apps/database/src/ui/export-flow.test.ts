import type { SaveFileService, SaveFileTarget } from "@brainstorm-os/sdk/export-file";
import type { EntityRow } from "@brainstorm-os/sdk/in-memory-entities";
import { describe, expect, it, vi } from "vitest";
import { ListExportFormat } from "../logic/list-export";
import { runListExport } from "./export-flow";

function row(id: string, properties: Record<string, unknown>): EntityRow {
	return { id, type: "brainstorm/Task/v1", properties, createdAt: 0, updatedAt: 0, deletedAt: null };
}

const ROWS = [row("a", { status: "todo" }), row("b", { status: "done" })];
const COLUMNS = [{ key: "status", header: "Status" }];

function stubFiles(target: SaveFileTarget | null): {
	files: SaveFileService;
	written: { handle: SaveFileTarget; data: Uint8Array | ArrayBuffer }[];
} {
	const written: { handle: SaveFileTarget; data: Uint8Array | ArrayBuffer }[] = [];
	return {
		written,
		files: {
			requestSave: vi.fn(async () => target),
			write: vi.fn(async (handle, data) => {
				written.push({ handle, data });
			}),
		},
	};
}

describe("runListExport", () => {
	it("writes the serialized list and reports the saved file", async () => {
		const target: SaveFileTarget = { handleId: "t", displayName: "my-list.csv" };
		const { files, written } = stubFiles(target);
		const notify = vi.fn();
		await runListExport({
			files,
			rows: ROWS,
			columns: COLUMNS,
			titleOf: (r) => `Task ${r.id}`,
			listTitle: "My List",
			format: ListExportFormat.Csv,
			notify,
		});
		expect(written).toHaveLength(1);
		const text = new TextDecoder().decode(written[0]?.data as Uint8Array);
		expect(text).toBe("Name,Status\r\nTask a,todo\r\nTask b,done");
		expect(notify).toHaveBeenCalledWith("Exported 2 rows to my-list.csv");
	});

	it("uses the right extension + filter per format", async () => {
		const target: SaveFileTarget = { handleId: "t", displayName: "my-list.json" };
		const { files } = stubFiles(target);
		await runListExport({
			files,
			rows: ROWS,
			columns: COLUMNS,
			titleOf: (r) => r.id,
			listTitle: "My List",
			format: ListExportFormat.Json,
			notify: vi.fn(),
		});
		const call = (files.requestSave as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
		expect(call.suggestedName).toBe("My List.json");
		expect(call.filters[0]).toEqual({ name: "JSON", extensions: ["json"] });
	});

	it("is a silent no-op when the user cancels the save dialog", async () => {
		const { files, written } = stubFiles(null);
		const notify = vi.fn();
		await runListExport({
			files,
			rows: ROWS,
			columns: COLUMNS,
			titleOf: (r) => r.id,
			listTitle: "My List",
			format: ListExportFormat.Markdown,
			notify,
		});
		expect(written).toHaveLength(0);
		expect(notify).not.toHaveBeenCalled();
	});

	it("reports a failure when write rejects", async () => {
		const target: SaveFileTarget = { handleId: "t", displayName: "x.csv" };
		const notify = vi.fn();
		const files: SaveFileService = {
			requestSave: vi.fn(async () => target),
			write: vi.fn(async () => {
				throw new Error("disk full");
			}),
		};
		await runListExport({
			files,
			rows: ROWS,
			columns: COLUMNS,
			titleOf: (r) => r.id,
			listTitle: "My List",
			format: ListExportFormat.Csv,
			notify,
		});
		expect(notify).toHaveBeenCalledWith("Export failed");
	});
});
