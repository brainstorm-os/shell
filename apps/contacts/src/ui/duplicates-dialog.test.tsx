// @vitest-environment jsdom
/**
 * Duplicates review dialog (F-158) — pins the two-step flow: the group list
 * (count + match-kind evidence), the survivor picker defaulting to the most
 * complete member, and the merge callback receiving the survivor, the
 * losers, and the field-level union patch.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DuplicateGroupView, DuplicateMatchKind } from "../logic/duplicates";
import type { Person } from "../types/person";
import { DuplicatesDialog } from "./duplicates-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	document.body.replaceChildren();
});

function person(id: string, over: Partial<Person> = {}): Person {
	return {
		id,
		name: "",
		emails: [],
		phones: [],
		companyId: null,
		role: "",
		birthday: null,
		anniversary: null,
		linkIds: [],
		bio: "",
		...over,
	};
}

const rich = person("rich", { name: "Dana Whitfield", emails: ["dana@x.com"], role: "Advisor" });
const thin = person("thin", { name: "Dana Whitfield", emails: ["dana@y.com"] });

function groupView(): DuplicateGroupView {
	return {
		group: { ids: ["rich", "thin"], kind: DuplicateMatchKind.Email },
		persons: [rich, thin],
		defaultSurvivorId: "rich",
	};
}

function render(over: Partial<Parameters<typeof DuplicatesDialog>[0]> = {}): {
	onMerge: ReturnType<typeof vi.fn>;
	onClose: ReturnType<typeof vi.fn>;
} {
	const onMerge = vi.fn();
	const onClose = vi.fn();
	act(() => {
		root.render(
			<DuplicatesDialog
				groups={[groupView()]}
				companyNameOf={() => null}
				onMerge={onMerge}
				onClose={onClose}
				{...over}
			/>,
		);
	});
	return { onMerge, onClose };
}

function click(el: Element | null | undefined): void {
	act(() => {
		(el as HTMLElement | null)?.click();
	});
}

describe("DuplicatesDialog", () => {
	it("lists each group with member count + match evidence", () => {
		render();
		expect(container.querySelector('[data-testid="contacts-duplicates"]')).not.toBeNull();
		const meta = container.querySelector(".contacts-dups__group-meta")?.textContent ?? "";
		expect(meta).toContain("2 contacts");
		expect(meta).toContain("Same email");
	});

	it("Review opens the survivor picker with the default (most complete) member pre-selected", () => {
		render();
		click(container.querySelector('[data-testid="contacts-dups-review"]'));
		const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
		expect(radios).toHaveLength(2);
		expect(radios.find((r) => r.value === "rich")?.checked).toBe(true);
		// The suggested badge marks the default survivor.
		expect(container.querySelector(".contacts-dups__badge")?.textContent).toBe("Suggested");
	});

	it("Merge fires with the survivor, the losers, and the union patch", () => {
		const { onMerge } = render();
		click(container.querySelector('[data-testid="contacts-dups-review"]'));
		click(container.querySelector('[data-testid="contacts-dups-merge"]'));
		expect(onMerge).toHaveBeenCalledTimes(1);
		const [survivorId, loserIds, patch] = onMerge.mock.calls[0] ?? [];
		expect(survivorId).toBe("rich");
		expect(loserIds).toEqual(["thin"]);
		// Field-level union: the loser's distinct email rides along.
		expect(patch).toEqual({ email: ["dana@x.com", "dana@y.com"] });
	});

	it("picking a different survivor swaps the merge direction", () => {
		const { onMerge } = render();
		click(container.querySelector('[data-testid="contacts-dups-review"]'));
		const thinRadio = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
			(r) => r.value === "thin",
		);
		act(() => {
			thinRadio?.click();
		});
		click(container.querySelector('[data-testid="contacts-dups-merge"]'));
		const [survivorId, loserIds, patch] = onMerge.mock.calls[0] ?? [];
		expect(survivorId).toBe("thin");
		expect(loserIds).toEqual(["rich"]);
		expect(patch).toMatchObject({ email: ["dana@y.com", "dana@x.com"], role: "Advisor" });
	});

	it("Escape closes via the shared popover contract", () => {
		const { onClose } = render();
		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
