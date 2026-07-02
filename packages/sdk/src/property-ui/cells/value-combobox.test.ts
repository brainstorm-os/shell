import { describe, expect, it } from "vitest";
import { COMBOBOX_FREE_TEXT_ID, comboboxRows } from "./value-combobox";

const useTyped = (q: string) => `Use "${q}"`;
const OPTIONS = ["To do", "In progress", "Done"];

describe("comboboxRows", () => {
	it("lists every existing value for an empty query, no synthetic row", () => {
		const rows = comboboxRows(OPTIONS, "", useTyped);
		expect(rows.map((r) => r.id)).toEqual(OPTIONS);
	});

	it("substring-filters case-insensitively (and offers the typed value)", () => {
		const rows = comboboxRows(OPTIONS, "do", useTyped);
		// "To do" and "Done" both contain "do"; "do" isn't an exact value, so the
		// synthetic "use typed text" row leads.
		expect(rows.map((r) => r.label)).toEqual(['Use "do"', "To do", "Done"]);
	});

	it("offers a 'use typed text' row when the query is a new value", () => {
		const rows = comboboxRows(OPTIONS, "Blocked", useTyped);
		expect(rows[0]).toEqual({ id: COMBOBOX_FREE_TEXT_ID, label: 'Use "Blocked"' });
	});

	it("does NOT offer the typed row when the query already matches a value exactly", () => {
		const rows = comboboxRows(OPTIONS, "done", useTyped);
		expect(rows.some((r) => r.id === COMBOBOX_FREE_TEXT_ID)).toBe(false);
		expect(rows.map((r) => r.label)).toEqual(["Done"]);
	});

	it("keeps the typed row when a partial match exists but no exact one", () => {
		const rows = comboboxRows(OPTIONS, "In", useTyped);
		expect(rows[0]?.id).toBe(COMBOBOX_FREE_TEXT_ID);
		expect(rows.map((r) => r.label)).toEqual(['Use "In"', "In progress"]);
	});
});
