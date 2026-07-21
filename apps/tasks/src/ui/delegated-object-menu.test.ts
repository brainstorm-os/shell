/**
 * @vitest-environment jsdom
 *
 * Delegated object-menu guard. The whole reason this module exists is to
 * collapse the old O(N) per-row `attachObjectMenuTrigger` (two listeners
 * + a built ⋯ button PER ROW PER RENDER) into ONE listener pair on the
 * stable container. These tests pin that invariant: exactly one binding
 * regardless of re-renders, and right-click / ⋯-click anywhere inside a
 * `[data-entity-id]` row resolves to that row's entity.
 */

import { closeObjectMenu } from "@brainstorm-os/sdk/object-menu";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ENTITY_ID_ATTR,
	ENTITY_TYPE_ATTR,
	bindDelegatedObjectMenu,
	createMoreButton,
} from "./delegated-object-menu";

function row(id: string): HTMLLIElement {
	const li = document.createElement("li");
	li.setAttribute(ENTITY_ID_ATTR, id);
	li.setAttribute(ENTITY_TYPE_ATTR, "brainstorm/Task/v1");
	const deepChild = document.createElement("span");
	deepChild.className = "task-row__name";
	deepChild.textContent = id;
	li.appendChild(deepChild);
	li.appendChild(createMoreButton());
	return li;
}

const runtime = { capabilities: [] as string[], services: {} };

afterEach(() => {
	closeObjectMenu();
	document.body.replaceChildren();
});

describe("bindDelegatedObjectMenu", () => {
	it("binds exactly once even if called repeatedly (idempotent)", () => {
		const container = document.createElement("ul");
		const add = vi.spyOn(container, "addEventListener");
		bindDelegatedObjectMenu(
			container,
			() => runtime,
			() => null,
		);
		bindDelegatedObjectMenu(
			container,
			() => runtime,
			() => null,
		);
		bindDelegatedObjectMenu(
			container,
			() => runtime,
			() => null,
		);
		// One contextmenu + one click — total two, never multiplied by the
		// re-bind attempts (the old code attached per row per render).
		expect(add).toHaveBeenCalledTimes(2);
		expect(container.dataset.objectMenuBound).toBe("true");
	});

	it("resolves the entity from a right-click on a DEEP child via closest()", async () => {
		const container = document.createElement("ul");
		container.append(row("a"), row("b"), row("c"));
		document.body.appendChild(container);
		const resolve = vi.fn(() => ({ entityType: "brainstorm/Task/v1", label: "B" }));
		bindDelegatedObjectMenu(container, () => runtime, resolve);

		const deep = container.children[1]?.querySelector(".task-row__name");
		deep?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
		await Promise.resolve();

		expect(resolve).toHaveBeenCalledWith("b", expect.anything());
	});

	it("resolves on a ⋯-button click and ignores clicks outside any row", async () => {
		const container = document.createElement("ul");
		container.append(row("only"));
		document.body.appendChild(container);
		const resolve = vi.fn(() => ({ entityType: "brainstorm/Task/v1", label: "x" }));
		bindDelegatedObjectMenu(container, () => runtime, resolve);

		// Click in dead space inside the container → no resolution.
		container.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(resolve).not.toHaveBeenCalled();

		const more = container.querySelector<HTMLButtonElement>(".bs-object-menu__more");
		more?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		await Promise.resolve();
		expect(resolve).toHaveBeenCalledWith("only", expect.anything());
	});

	it("no-ops with a null runtime (preview mode) without calling resolve", () => {
		const container = document.createElement("ul");
		container.append(row("a"));
		document.body.appendChild(container);
		const resolve = vi.fn(() => ({ entityType: "brainstorm/Task/v1", label: "a" }));
		bindDelegatedObjectMenu(container, () => null, resolve);

		container.children[0]?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		expect(resolve).not.toHaveBeenCalled();
	});
});
