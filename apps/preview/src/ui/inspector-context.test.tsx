// @vitest-environment jsdom
/**
 * 9.20.15 — Preview's context panel: the caption row (a first-class File
 * property), backlinks (who links here; opens in a new tab) and Move to Bin,
 * each honouring the fleet's read-only lock on every write path.
 */
import { RightPanelTab } from "@brainstorm-os/editor";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreviewRuntime } from "../host/runtime";
import { flush, renderInto } from "../test/render";
import { Inspector } from "./inspector";

const NOOP = () => undefined;
const FILE_ID = "file-1";

type Snapshot = {
	entities: Array<{
		id: string;
		type: string;
		properties: Record<string, unknown>;
		createdAt: number;
		updatedAt: number;
		deletedAt: number | null;
	}>;
	links: Array<{
		id: string;
		sourceEntityId: string;
		destEntityId: string;
		linkType: string;
		createdAt: number;
		deletedAt: null;
	}>;
};

function snapshot(fileProps: Record<string, unknown>): Snapshot {
	const entity = (id: string, type: string, properties: Record<string, unknown>, updatedAt = 1) => ({
		id,
		type,
		properties,
		createdAt: 0,
		updatedAt,
		deletedAt: null,
	});
	const link = (source: string) => ({
		id: `l-${source}`,
		sourceEntityId: source,
		destEntityId: FILE_ID,
		linkType: "io.brainstorm.notes/link",
		createdAt: 0,
		deletedAt: null,
	});
	return {
		entities: [
			entity(FILE_ID, "brainstorm/File/v1", { name: "sunset.png", mime: "image/png", ...fileProps }),
			entity("note-1", "io.brainstorm.notes/Note/v1", { title: "Trip notes" }, 5),
			entity("task-1", "brainstorm/Task/v1", { title: "Print it" }, 9),
		],
		links: [link("note-1"), link("task-1")],
	};
}

function runtimeFor(fileProps: Record<string, unknown>) {
	const update = vi.fn(async () => ({}));
	const del = vi.fn(async () => undefined);
	const dispatch = vi.fn(async () => undefined);
	const snap = snapshot(fileProps);
	const runtime = {
		services: {
			vaultEntities: { list: async () => snap, onChange: () => ({ unsubscribe: NOOP }) },
			entities: { update, delete: del },
			properties: {
				list: async () => ({ properties: {}, dictionaries: {} }),
				onChange: () => ({ unsubscribe: NOOP }),
			},
			intents: { dispatch },
		},
	} as unknown as PreviewRuntime;
	return { runtime, update, del, dispatch };
}

async function mount(fileProps: Record<string, unknown>, onDeleted = vi.fn()) {
	const deps = runtimeFor(fileProps);
	const handle = await renderInto(
		<Inspector
			runtime={deps.runtime}
			entityId={FILE_ID}
			file={{ name: "sunset.png", mime: "image/png", sizeBytes: 10, modifiedAt: 0 }}
			pairs={[]}
			activeTab={RightPanelTab.Properties}
			onTabChange={NOOP}
			onClose={NOOP}
			onDeleted={onDeleted}
		/>,
	);
	await flush();
	await flush();
	return { ...deps, ...handle, onDeleted };
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("Preview context panel (9.20.15)", () => {
	it("edits the caption through entities.update", async () => {
		const h = await mount({ caption: "Golden hour" });
		const cell = h.container.querySelector<HTMLButtonElement>(".bs-cell-multiline");
		expect(cell?.textContent).toBe("Golden hour");
		act(() => cell?.click());
		const ta = h.container.querySelector<HTMLTextAreaElement>(".bs-cell-multiline-input");
		if (!ta) throw new Error("caption editor did not open");
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
				ta,
				"Blue hour",
			);
			ta.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		expect(h.update).toHaveBeenCalledWith(FILE_ID, { caption: "Blue hour" });
		await h.unmount();
	});

	it("lists every live backlink source, freshest first, and opens one in a new tab", async () => {
		const h = await mount({});
		const links = Array.from(
			h.container.querySelectorAll<HTMLButtonElement>(".preview-context__link"),
		);
		expect(links.map((l) => l.textContent)).toEqual(["Print it", "Trip notes"]);
		expect(h.container.querySelector(".preview-context__heading")?.textContent).toBe(
			"Linked from 2 objects",
		);
		act(() => links[1]?.click());
		expect(h.dispatch).toHaveBeenCalledWith({
			verb: "open",
			payload: { entityId: "note-1", entityType: "io.brainstorm.notes/Note/v1", navMode: "new-tab" },
		});
		await h.unmount();
	});

	it("moves the file to the Bin and tells the host", async () => {
		const h = await mount({});
		const bin = h.container.querySelector<HTMLButtonElement>('[data-testid="preview-move-to-bin"]');
		await act(async () => {
			bin?.click();
			await Promise.resolve();
		});
		expect(h.del).toHaveBeenCalledWith(FILE_ID);
		expect(h.onDeleted).toHaveBeenCalledWith(FILE_ID);
		await h.unmount();
	});

	it("refuses every write path on a locked file", async () => {
		const h = await mount({ caption: "Keep", locked: true });
		const bin = h.container.querySelector<HTMLButtonElement>('[data-testid="preview-move-to-bin"]');
		expect(bin?.disabled).toBe(true);
		expect(bin?.title).toBe("Unlock this file to change it");
		await act(async () => {
			bin?.click();
			await Promise.resolve();
		});
		const cell = h.container.querySelector<HTMLButtonElement>(".bs-cell-multiline");
		expect(cell?.disabled).toBe(true);
		act(() => cell?.click());
		expect(h.container.querySelector(".bs-cell-multiline-input")).toBeNull();
		expect(h.del).not.toHaveBeenCalled();
		expect(h.update).not.toHaveBeenCalled();
		await h.unmount();
	});
});
