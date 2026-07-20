import { EMAIL_TYPE_URL, FolderRole, MailFlag } from "@brainstorm/sdk-types";
import { describe, expect, it } from "vitest";
import type { RawMessage } from "./mail-driver";
import { folderRoleForPath, projectFolder, projectMessage } from "./mail-projection";

void EMAIL_TYPE_URL;

describe("folderRoleForPath", () => {
	it("honours a driver-supplied role", () => {
		expect(folderRoleForPath("Whatever", FolderRole.Trash)).toBe(FolderRole.Trash);
	});

	it("maps common IMAP / Gmail paths", () => {
		expect(folderRoleForPath("INBOX")).toBe(FolderRole.Inbox);
		expect(folderRoleForPath("[Gmail]/Sent Mail")).toBe(FolderRole.Sent);
		expect(folderRoleForPath("[Gmail]/Drafts")).toBe(FolderRole.Drafts);
		expect(folderRoleForPath("Archive")).toBe(FolderRole.Archive);
		expect(folderRoleForPath("[Gmail]/Trash")).toBe(FolderRole.Trash);
		expect(folderRoleForPath("Junk")).toBe(FolderRole.Spam);
		expect(folderRoleForPath("Receipts/2024")).toBe(FolderRole.Custom);
	});
});

describe("projectFolder", () => {
	it("projects an account-scoped folder with a defaulted unread count", () => {
		expect(projectFolder("acct-1", { path: "INBOX" })).toEqual({
			accountRef: "acct-1",
			path: "INBOX",
			role: FolderRole.Inbox,
			unreadCount: 0,
		});
	});
});

const raw = (over: Partial<RawMessage> = {}): RawMessage => ({
	messageId: "<m1@x>",
	from: "Dana Lee <dana@example.com>",
	to: "you@example.com, Bob <bob@example.com>",
	subject: "Hello",
	receivedAt: 1000,
	folderPath: "INBOX",
	...over,
});

describe("projectMessage", () => {
	it("parses headers into MailAddress[] and sets the folder ref", () => {
		const def = projectMessage("acct-1", raw(), "folder-1");
		expect(def.accountRef).toBe("acct-1");
		expect(def.folderRefs).toEqual(["folder-1"]);
		expect(def.from).toEqual([{ address: "dana@example.com", name: "Dana Lee" }]);
		expect(def.to).toEqual([
			{ address: "you@example.com" },
			{ address: "bob@example.com", name: "Bob" },
		]);
		expect(def.subject).toBe("Hello");
	});

	it("derives threadKey from References root over message id", () => {
		const def = projectMessage(
			"a",
			raw({ messageId: "<m3@x>", references: ["<root@x>", "<m2@x>"] }),
			"f",
		);
		expect(def.threadKey).toBe("root@x");
	});

	it("sanitises the HTML body into bodyHtmlSafe", () => {
		const def = projectMessage("a", raw({ bodyHtml: "<p>hi</p><script>steal()</script>" }), "f");
		expect(def.bodyHtmlSafe).toContain("<p>hi</p>");
		expect(def.bodyHtmlSafe).not.toContain("steal");
	});

	it("omits bodyHtmlSafe when the body sanitises to nothing", () => {
		const def = projectMessage("a", raw({ bodyHtml: "<script>x</script>" }), "f");
		expect(def.bodyHtmlSafe).toBeUndefined();
	});

	it("carries flags and a stamped submissionId from extra", () => {
		const def = projectMessage("a", raw({ flags: [MailFlag.Unread] }), "f", {
			submissionId: "sub-1",
			flags: [],
		});
		expect(def.flags).toEqual([]);
		expect(def.submissionId).toBe("sub-1");
	});

	it("carries attachment part metadata through and mints no file refs at sync", () => {
		const parts = [{ partRef: "m1:att-1", filename: "report.pdf", mimeType: "application/pdf" }];
		const def = projectMessage("a", raw({ attachmentParts: parts }), "f");
		expect(def.attachmentParts).toEqual(parts);
		// Sync is metadata-only — a File entity exists only once bytes are fetched.
		expect(def.attachments).toBeUndefined();
	});
});
