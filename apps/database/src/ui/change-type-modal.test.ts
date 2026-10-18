// @vitest-environment jsdom
import { type PropertyDef, ValueType } from "@brainstorm-os/sdk-types";
import { afterEach, describe, expect, it } from "vitest";
import { planTypeChange } from "../logic/change-type";
import type { EntityRow } from "../logic/in-memory-entities";
import { openChangeTypeModal } from "./change-type-modal";

const row = (id: string, size: unknown): EntityRow => ({
	id,
	type: "t",
	properties: { size },
	createdAt: 0,
	updatedAt: 0,
	deletedAt: null,
});
const DEF: PropertyDef = { key: "size", name: "Size", icon: null, valueType: ValueType.Text };

function open() {
	const plan = planTypeChange([row("a", "3"), row("b", "huge")], DEF, ValueType.Number);
	return openChangeTypeModal({
		plan,
		propertyName: "Size",
		typeLabel: "Number",
		titleOf: (id) => `Row ${id}`,
		display: (v) => String(v),
	});
}

afterEach(() => document.body.replaceChildren());

describe("change-type preview modal (9.12.33)", () => {
	it("lists the conversions and the rows that would lose data, then confirms", async () => {
		const result = open();
		const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);
		expect(q("db-change-type-summary")?.textContent).toBe(
			"1 value converts · 1 would lose its value",
		);
		expect(q("db-change-type-lost")?.textContent).toBe("Row b — huge");
		expect(q("db-change-type-preview")?.textContent).toBe("Row a: 3 → 3");
		(q("db-change-type-confirm") as HTMLButtonElement).click();
		await expect(result).resolves.toBe(true);
		expect(q("db-change-type-modal")).toBeNull();
	});

	it("cancels without committing", async () => {
		const result = open();
		document.querySelector<HTMLButtonElement>(".db-import-modal__cancel")?.click();
		await expect(result).resolves.toBe(false);
	});
});
