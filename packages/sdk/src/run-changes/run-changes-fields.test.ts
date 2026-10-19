import { AGENT_PROVENANCE_PROPERTY_KEY, type AgentFieldChange } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { formatDate, formatTime } from "../date-formatters";
import { formatChangePreview, humanFieldChanges } from "./run-changes-fields";

const STAMP = 1792445200119;
const row = (
	key: string,
	after: string | null,
	before: string | null = null,
): AgentFieldChange => ({
	key,
	before,
	after,
});

describe("humanFieldChanges", () => {
	it("drops host bookkeeping, provenance keys and empty bags", () => {
		const rows = humanFieldChanges([
			row("title", "Signage checklist"),
			row("values", "{}"),
			row("createdAt", String(STAMP)),
			row("updatedAt", String(STAMP)),
			row(AGENT_PROVENANCE_PROPERTY_KEY, '{"runId":"r"}'),
			row("tags", "[]"),
		]);
		expect(rows).toEqual([row("title", "Signage checklist")]);
	});

	it("keeps a cleared field and a body's line summary", () => {
		const rows = humanFieldChanges([
			{ key: "body", before: "a\nb", after: "a", lines: { added: 0, removed: 1 } },
			row("status", null, "open"),
		]);
		expect(rows).toEqual([
			{ key: "body", before: "a\nb", after: "a", lines: { added: 0, removed: 1 } },
			row("status", null, "open"),
		]);
	});
});

describe("formatChangePreview", () => {
	it("reads an epoch stamp on a date-shaped key through the shared formatters", () => {
		const ctx = { locale: "en-GB", timeZone: "UTC", hour12: false };
		expect(formatChangePreview("dueAt", String(STAMP), ctx)).toBe(
			`${formatDate(STAMP, ctx)} ${formatTime(STAMP, ctx)}`,
		);
		expect(formatChangePreview("dueAt", String(STAMP), ctx)).toContain("2026");
	});

	it("leaves non-date keys, non-epoch values and out-of-range stamps alone", () => {
		expect(formatChangePreview("amount", String(STAMP))).toBe(String(STAMP));
		expect(formatChangePreview("dueAt", "next Friday")).toBe("next Friday");
		expect(formatChangePreview("dueAt", "1")).toBe("1");
		expect(formatChangePreview("dueAt", "9999999999999")).toBe("9999999999999");
	});
});
