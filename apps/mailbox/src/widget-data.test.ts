/**
 * Mailbox `inbox` dashboard widget — pure data-shaping coverage. The
 * `shapeInbox` projection is the widget's only non-presentational logic; the
 * component shell mirrors the real-shell-verified Contacts / Journal widgets.
 */

import { MailFlag } from "@brainstorm/sdk-types";
import { describe, expect, it } from "vitest";
import { EMAIL_TYPE_URL, MAIL_FOLDER_TYPE_URL } from "./types/mail-view";
import { LIST_LIMIT, type WidgetEmailEntity, shapeInbox } from "./widget-data";

function email(
	id: string,
	properties: Record<string, unknown>,
	deletedAt: number | null = null,
): WidgetEmailEntity {
	return {
		id,
		type: EMAIL_TYPE_URL,
		properties: { from: [{ address: `${id}@example.com` }], subject: id, ...properties },
		deletedAt,
	};
}

describe("shapeInbox", () => {
	it("keeps only non-deleted Email/v1 rows", () => {
		const entities: WidgetEmailEntity[] = [
			email("live", { receivedAt: 100 }),
			{ ...email("folder", {}), type: MAIL_FOLDER_TYPE_URL },
			email("binned", { receivedAt: 200 }, 123),
		];
		const { rows, total } = shapeInbox(entities);
		expect(total).toBe(1);
		expect(rows.map((r) => r.id)).toEqual(["live"]);
	});

	it("orders unread first, each group newest-receivedAt first", () => {
		const entities = [
			email("read-new", { receivedAt: 400 }),
			email("unread-old", { receivedAt: 100, flags: [MailFlag.Unread] }),
			email("read-old", { receivedAt: 200 }),
			email("unread-new", { receivedAt: 300, flags: [MailFlag.Unread] }),
		];
		const { rows } = shapeInbox(entities);
		expect(rows.map((r) => r.id)).toEqual(["unread-new", "unread-old", "read-new", "read-old"]);
	});

	it("shows the sender name, falling back to the address, then the unknown label", () => {
		const entities = [
			email("named", { from: [{ name: "Ada Lovelace", address: "ada@example.com" }] }),
			email("blank-name", { from: [{ name: "   ", address: "grace@example.com" }] }),
			email("no-from", { from: [] }),
		];
		const byId = new Map(shapeInbox(entities).rows.map((r) => [r.id, r.sender]));
		expect(byId.get("named")).toBe("Ada Lovelace");
		expect(byId.get("blank-name")).toBe("grace@example.com");
		expect(byId.get("no-from")?.length).toBeGreaterThan(0);
	});

	it("falls back to the shared no-subject label when the subject is blank", () => {
		const { rows } = shapeInbox([email("m", { subject: "  " })]);
		expect(rows[0]?.subject.length).toBeGreaterThan(0);
	});

	it("counts every live unread message, independent of the limit", () => {
		const entities = Array.from({ length: 12 }, (_, i) =>
			email(`m${i}`, { receivedAt: i, flags: [MailFlag.Unread] }),
		);
		const { rows, unread, total } = shapeInbox(entities, 3);
		expect(rows).toHaveLength(3);
		expect(unread).toBe(12);
		expect(total).toBe(12);
	});

	it("caps the projection at the default limit but reports the full total", () => {
		const entities = Array.from({ length: 12 }, (_, i) => email(`m${i}`, { receivedAt: i }));
		const { rows, total } = shapeInbox(entities);
		expect(rows).toHaveLength(LIST_LIMIT);
		expect(total).toBe(12);
	});

	it("parses flags through the MailFlag enum guard — junk strings never read as unread", () => {
		const entities = [
			email("junk-flag", { receivedAt: 100, flags: ["unread!", "UNREAD", 7] }),
			email("not-array", { receivedAt: 200, flags: "unread" }),
			email("real", { receivedAt: 50, flags: [MailFlag.Unread, MailFlag.Flagged] }),
		];
		const { rows, unread } = shapeInbox(entities);
		expect(unread).toBe(1);
		expect(rows.map((r) => r.id)).toEqual(["real", "not-array", "junk-flag"]);
		expect(rows.find((r) => r.id === "real")?.unread).toBe(true);
		expect(rows.find((r) => r.id === "junk-flag")?.unread).toBe(false);
	});
});
