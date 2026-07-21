/**
 * @vitest-environment jsdom
 *
 * Delegated object-menu guard for Journal — replaces the old per-render
 * dispose/rebuild of a trigger array (one per entry header AND per
 * backlink row). One listener pair on the stable root; the resolver
 * receives the matched element so the entry header vs. backlink label
 * survives.
 */

import { closeObjectMenu } from "@brainstorm-os/sdk/object-menu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENTITY_ID_ATTR, bindDelegatedObjectMenu, createMoreButton } from "./delegated-object-menu";

function noteRow(id: string, label: string): HTMLDivElement {
	const div = document.createElement("div");
	div.setAttribute(ENTITY_ID_ATTR, id);
	div.setAttribute("data-entity-label", label);
	const title = document.createElement("h1");
	title.textContent = label;
	div.appendChild(title);
	div.appendChild(createMoreButton("More"));
	return div;
}

const runtime = { capabilities: [] as string[], services: {} };
const labels = () => ({ open: "Open in Notes" });

afterEach(() => {
	closeObjectMenu();
	document.body.replaceChildren();
});

describe("journal bindDelegatedObjectMenu", () => {
	it("is idempotent across re-binds", () => {
		const root = document.createElement("div");
		const add = vi.spyOn(root, "addEventListener");
		bindDelegatedObjectMenu(
			root,
			() => runtime,
			() => null,
			labels,
		);
		bindDelegatedObjectMenu(
			root,
			() => runtime,
			() => null,
			labels,
		);
		expect(add).toHaveBeenCalledTimes(2);
	});

	it("passes the matched element to the resolver so the row label survives", async () => {
		const root = document.createElement("div");
		root.append(noteRow("note-1", "2026-05-14"), noteRow("note-2", "Linked note"));
		document.body.appendChild(root);
		const resolve = vi.fn((_id: string, el: HTMLElement | null) => ({
			entityType: "io.brainstorm.notes/Note/v1",
			label: el?.getAttribute("data-entity-label") ?? _id,
		}));
		bindDelegatedObjectMenu(root, () => runtime, resolve, labels);

		root.children[1]
			?.querySelector("h1")
			?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		await Promise.resolve();

		expect(resolve).toHaveBeenCalledTimes(1);
		const [id, el] = resolve.mock.calls[0] ?? [];
		expect(id).toBe("note-2");
		expect((el as HTMLElement).getAttribute("data-entity-label")).toBe("Linked note");
	});
});
