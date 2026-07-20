import { Buffer } from "node:buffer";
import { FolderRole, MailFlag, MailProtocol } from "@brainstorm/sdk-types";
import { describe, expect, it } from "vitest";
import { makeGmailDriver } from "./gmail-driver";

type Recorded = { url: string; init: RequestInit | undefined };

type RouteHandler = (url: URL, init: RequestInit | undefined) => unknown;

function stubFetch(handler: RouteHandler): { impl: typeof fetch; requests: Recorded[] } {
	const requests: Recorded[] = [];
	const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		requests.push({ url, init });
		const out = handler(new URL(url), init);
		if (out instanceof Response) return out;
		return new Response(JSON.stringify(out), { status: 200 });
	}) as typeof fetch;
	return { impl, requests };
}

const b64url = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

const LABELS = {
	labels: [
		{ id: "INBOX", name: "INBOX", type: "system" },
		{ id: "SENT", name: "SENT", type: "system" },
		{ id: "DRAFT", name: "DRAFT", type: "system" },
		{ id: "TRASH", name: "TRASH", type: "system" },
		{ id: "SPAM", name: "SPAM", type: "system" },
		{ id: "UNREAD", name: "UNREAD", type: "system" },
		{ id: "STARRED", name: "STARRED", type: "system" },
		{ id: "IMPORTANT", name: "IMPORTANT", type: "system" },
		{ id: "CHAT", name: "CHAT", type: "system" },
		{ id: "CATEGORY_SOCIAL", name: "CATEGORY_SOCIAL", type: "system" },
		{ id: "CATEGORY_PROMOTIONS", name: "CATEGORY_PROMOTIONS", type: "system" },
		{ id: "Label_7", name: "Receipts/2024", type: "user" },
	],
};

function labelRoutes(url: URL): unknown | undefined {
	if (url.pathname === "/gmail/v1/users/me/labels") return LABELS;
	if (url.pathname === "/gmail/v1/users/me/labels/INBOX") {
		return { id: "INBOX", name: "INBOX", messagesUnread: 7 };
	}
	return undefined;
}

function makeDriver(handler: RouteHandler, now?: () => number) {
	const { impl, requests } = stubFetch(handler);
	const driver = makeGmailDriver({
		credentials: { secret: "tok-123" },
		fetchImpl: impl,
		...(now ? { now } : {}),
	});
	return { driver, requests };
}

describe("makeGmailDriver", () => {
	it("exposes the gmail-api protocol", () => {
		const { driver } = makeDriver(() => ({}));
		expect(driver.protocol).toBe(MailProtocol.GmailApi);
	});

	it("sends the bearer token on every request", async () => {
		const { driver, requests } = makeDriver((url) => labelRoutes(url) ?? {});
		await driver.listFolders();
		expect(requests.length).toBeGreaterThan(0);
		for (const req of requests) {
			expect((req.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
		}
	});

	describe("listFolders", () => {
		it("maps system roles, keeps user labels, excludes non-folder labels", async () => {
			const { driver } = makeDriver((url) => labelRoutes(url) ?? {});
			const folders = await driver.listFolders();
			const byPath = new Map(folders.map((f) => [f.path, f]));
			expect(byPath.get("INBOX")?.role).toBe(FolderRole.Inbox);
			expect(byPath.get("SENT")?.role).toBe(FolderRole.Sent);
			expect(byPath.get("DRAFT")?.role).toBe(FolderRole.Drafts);
			expect(byPath.get("TRASH")?.role).toBe(FolderRole.Trash);
			expect(byPath.get("SPAM")?.role).toBe(FolderRole.Spam);
			expect(byPath.get("Receipts/2024")?.role).toBe(FolderRole.Custom);
			expect(folders).toHaveLength(6);
			for (const excluded of [
				"UNREAD",
				"STARRED",
				"IMPORTANT",
				"CHAT",
				"CATEGORY_SOCIAL",
				"CATEGORY_PROMOTIONS",
			]) {
				expect(byPath.has(excluded)).toBe(false);
			}
		});

		it("fetches the unread count for INBOX only (one extra call)", async () => {
			const { driver, requests } = makeDriver((url) => labelRoutes(url) ?? {});
			const folders = await driver.listFolders();
			const inbox = folders.find((f) => f.role === FolderRole.Inbox);
			expect(inbox?.unreadCount).toBe(7);
			expect(folders.find((f) => f.role === FolderRole.Sent)?.unreadCount).toBeUndefined();
			expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
				"/gmail/v1/users/me/labels",
				"/gmail/v1/users/me/labels/INBOX",
			]);
		});
	});

	describe("fetch", () => {
		it("builds the list URL: labelIds, clamped maxResults, pageToken, q=after seconds", async () => {
			const { driver, requests } = makeDriver((url) => {
				if (url.pathname === "/gmail/v1/users/me/messages") return { messages: [] };
				return labelRoutes(url) ?? {};
			});
			const result = await driver.fetch({
				folderPath: "Receipts/2024",
				limit: 1000,
				cursor: "page-2",
				sinceMs: 1_717_000_000_123,
			});
			// Cold cache: the label list is refreshed before the message list.
			const listReq = requests.find((r) => new URL(r.url).pathname.endsWith("/messages"));
			expect(requests[0]?.url).toContain("/gmail/v1/users/me/labels");
			expect(listReq).toBeDefined();
			const params = new URL(listReq?.url ?? "").searchParams;
			expect(params.get("labelIds")).toBe("Label_7");
			expect(params.get("maxResults")).toBe("500");
			expect(params.get("pageToken")).toBe("page-2");
			expect(params.get("q")).toBe("after:1717000000");
			expect(result.messages).toEqual([]);
			expect(result.nextCursor).toBeUndefined();
		});

		it("omits pageToken and q when cursor/sinceMs are absent", async () => {
			const { driver, requests } = makeDriver((url) => {
				if (url.pathname === "/gmail/v1/users/me/messages") return { messages: [] };
				return labelRoutes(url) ?? {};
			});
			await driver.fetch({ folderPath: "INBOX", limit: 25 });
			const params = new URL(
				requests.find((r) => new URL(r.url).pathname.endsWith("/messages"))?.url ?? "",
			).searchParams;
			expect(params.get("labelIds")).toBe("INBOX");
			expect(params.get("maxResults")).toBe("25");
			expect(params.has("pageToken")).toBe(false);
			expect(params.has("q")).toBe(false);
		});

		it("projects a full message: headers, nested multipart bodies, flags, references, attachments", async () => {
			const full = {
				id: "m1",
				threadId: "t1",
				labelIds: ["INBOX", "UNREAD", "STARRED"],
				internalDate: "1717000050000",
				payload: {
					mimeType: "multipart/mixed",
					headers: [
						{ name: "from", value: "Dana Lee <dana@example.com>" },
						{ name: "TO", value: "you@example.com" },
						{ name: "Cc", value: "bob@example.com" },
						{ name: "Subject", value: "Quarterly report" },
						{ name: "MESSAGE-ID", value: "<orig-1@example.com>" },
						{ name: "In-Reply-To", value: "<root-0@example.com>" },
						{ name: "References", value: "<root-0@example.com>\t <mid-1@example.com>" },
					],
					parts: [
						{
							mimeType: "multipart/alternative",
							parts: [
								{ mimeType: "text/plain", body: { data: b64url("plain body ✓") } },
								{ mimeType: "text/html", body: { data: b64url("<p>html body</p>") } },
							],
						},
						{
							mimeType: "application/pdf",
							filename: "report.pdf",
							body: { attachmentId: "att-1" },
						},
					],
				},
			};
			const { driver } = makeDriver((url) => {
				if (url.pathname === "/gmail/v1/users/me/messages") return { messages: [{ id: "m1" }] };
				if (url.pathname === "/gmail/v1/users/me/messages/m1") {
					expect(url.searchParams.get("format")).toBe("full");
					return full;
				}
				return labelRoutes(url) ?? {};
			});
			const { messages } = await driver.fetch({ folderPath: "INBOX", limit: 10 });
			expect(messages).toHaveLength(1);
			expect(messages[0]).toEqual({
				messageId: "<orig-1@example.com>",
				providerThreadId: "t1",
				inReplyTo: "<root-0@example.com>",
				references: ["<root-0@example.com>", "<mid-1@example.com>"],
				from: "Dana Lee <dana@example.com>",
				to: "you@example.com",
				cc: "bob@example.com",
				subject: "Quarterly report",
				receivedAt: 1_717_000_050_000,
				bodyText: "plain body ✓",
				bodyHtml: "<p>html body</p>",
				flags: [MailFlag.Unread, MailFlag.Flagged],
				folderPath: "INBOX",
				attachmentParts: [{ partRef: "m1:att-1", filename: "report.pdf", mimeType: "application/pdf" }],
			});
		});

		it("falls back to a synthetic Message-ID and read flags when headers/labels are missing", async () => {
			const { driver } = makeDriver((url) => {
				if (url.pathname === "/gmail/v1/users/me/messages") return { messages: [{ id: "m2" }] };
				if (url.pathname === "/gmail/v1/users/me/messages/m2") {
					return {
						id: "m2",
						threadId: "t2",
						labelIds: ["INBOX"],
						internalDate: "1000",
						payload: {
							mimeType: "text/plain",
							headers: [{ name: "From", value: "a@x.com" }],
							body: { data: b64url("hi") },
						},
					};
				}
				return labelRoutes(url) ?? {};
			});
			const { messages } = await driver.fetch({ folderPath: "INBOX", limit: 10 });
			expect(messages[0]?.messageId).toBe("<gmail-m2@mail.gmail.com>");
			expect(messages[0]?.flags).toEqual([]);
			expect(messages[0]?.bodyText).toBe("hi");
			expect(messages[0]?.bodyHtml).toBeUndefined();
			expect(messages[0]?.attachmentParts).toBeUndefined();
		});

		it("returns nextPageToken as nextCursor", async () => {
			const { driver } = makeDriver((url) => {
				if (url.pathname === "/gmail/v1/users/me/messages") {
					return { messages: [], nextPageToken: "tok-next" };
				}
				return labelRoutes(url) ?? {};
			});
			const result = await driver.fetch({ folderPath: "INBOX", limit: 10 });
			expect(result.nextCursor).toBe("tok-next");
		});

		it("rejects an unknown folder after refreshing the label cache", async () => {
			const { driver } = makeDriver((url) => labelRoutes(url) ?? {});
			await expect(driver.fetch({ folderPath: "Nope", limit: 10 })).rejects.toMatchObject({
				name: "Invalid",
			});
		});
	});

	describe("submit", () => {
		const outbound = {
			from: "me@example.com",
			to: ["you@example.com", "her@example.com"],
			cc: ["cc@example.com"],
			subject: "Héllo ☃",
			bodyText: "plain text",
			bodyHtml: "<p>rich</p>",
			submissionId: "sub/1:2",
			inReplyTo: "<root@example.com>",
			references: ["<root@example.com>", "<mid@example.com>"],
		};

		it("POSTs an RFC 5322 MIME message and returns the stamped Message-ID", async () => {
			const { driver, requests } = makeDriver(
				(url) => {
					if (url.pathname === "/gmail/v1/users/me/messages/send") return { id: "sent-1" };
					return labelRoutes(url) ?? {};
				},
				() => 1_717_000_111_000,
			);
			const result = await driver.submit(outbound);
			expect(result).toEqual({
				messageId: "<sub12@brainstorm.local>",
				receivedAt: 1_717_000_111_000,
			});

			const sendReq = requests.find((r) => r.url.endsWith("/messages/send"));
			expect(sendReq?.init?.method).toBe("POST");
			const posted = JSON.parse(String(sendReq?.init?.body)) as { raw: string };
			const mime = Buffer.from(posted.raw, "base64url").toString("utf8");

			expect(mime).toContain("Message-ID: <sub12@brainstorm.local>");
			expect(mime).toContain(`Date: ${new Date(1_717_000_111_000).toUTCString()}`);
			expect(mime).toContain("From: me@example.com");
			expect(mime).toContain("To: you@example.com, her@example.com");
			expect(mime).toContain("Cc: cc@example.com");
			expect(mime).toContain(
				`Subject: =?UTF-8?B?${Buffer.from("Héllo ☃", "utf8").toString("base64")}?=`,
			);
			expect(mime).toContain("In-Reply-To: <root@example.com>");
			expect(mime).toContain("References: <root@example.com> <mid@example.com>");
			expect(mime).toContain("MIME-Version: 1.0");

			expect(mime).toContain('Content-Type: multipart/alternative; boundary="bs-sub12"');
			const boundarySplits = mime.split("--bs-sub12");
			// preamble, text part, html part, terminator
			expect(boundarySplits).toHaveLength(4);
			expect(boundarySplits[3]?.startsWith("--")).toBe(true);
			expect(boundarySplits[1]).toContain("Content-Type: text/plain; charset=utf-8");
			expect(boundarySplits[1]).toContain("Content-Transfer-Encoding: base64");
			expect(boundarySplits[1]).toContain(Buffer.from("plain text", "utf8").toString("base64"));
			expect(boundarySplits[2]).toContain("Content-Type: text/html; charset=utf-8");
			expect(boundarySplits[2]).toContain(Buffer.from("<p>rich</p>", "utf8").toString("base64"));
		});

		it("sends a single text/plain part (ASCII subject stays literal)", async () => {
			const { driver, requests } = makeDriver((url) => {
				if (url.pathname === "/gmail/v1/users/me/messages/send") return { id: "sent-2" };
				return labelRoutes(url) ?? {};
			});
			await driver.submit({
				from: "me@example.com",
				to: ["you@example.com"],
				subject: "Plain subject",
				bodyText: "just text",
				submissionId: "abc-123",
			});
			const sendReq = requests.find((r) => r.url.endsWith("/messages/send"));
			const posted = JSON.parse(String(sendReq?.init?.body)) as { raw: string };
			const mime = Buffer.from(posted.raw, "base64url").toString("utf8");
			expect(mime).toContain("Subject: Plain subject");
			expect(mime).toContain("Content-Type: text/plain; charset=utf-8");
			expect(mime).not.toContain("multipart/alternative");
			expect(mime).toContain(Buffer.from("just text", "utf8").toString("base64"));
		});
	});

	describe("error mapping", () => {
		const failWith = (status: number) => () =>
			new Response(JSON.stringify({ error: { message: "boom" } }), { status });

		it("rejects CR/LF in any outbound header value (header injection)", async () => {
			const { driver, requests } = makeDriver((url) => {
				if (url.pathname === "/gmail/v1/users/me/messages/send") return { id: "sent-x" };
				return labelRoutes(url) ?? {};
			});
			const safe = {
				from: "me@example.com",
				to: ["you@example.com"],
				bodyText: "hi",
				submissionId: "sub-inject",
			};
			await expect(
				driver.submit({ ...safe, subject: "Hi\r\nBcc: attacker@evil.com" }),
			).rejects.toMatchObject({ name: "Invalid" });
			await expect(
				driver.submit({ ...safe, to: ["you@example.com\nBcc: x@evil.com"] }),
			).rejects.toMatchObject({ name: "Invalid" });
			// Fails closed BEFORE any network call.
			expect(requests.find((r) => r.url.endsWith("/messages/send"))).toBeUndefined();
		});

		it("maps 401 to Denied with method + status in the message", async () => {
			const { driver } = makeDriver(failWith(401));
			await expect(driver.listFolders()).rejects.toMatchObject({
				name: "Denied",
				message: expect.stringContaining("gmail: listFolders 401"),
			});
		});

		it("maps 500 to Unavailable", async () => {
			const { driver } = makeDriver(failWith(500));
			await expect(driver.listFolders()).rejects.toMatchObject({
				name: "Unavailable",
				message: expect.stringContaining("gmail: listFolders 500"),
			});
		});

		it("maps 429 to Unavailable and other statuses to Invalid", async () => {
			const throttled = makeDriver(failWith(429));
			await expect(throttled.driver.listFolders()).rejects.toMatchObject({
				name: "Unavailable",
			});
			const notFound = makeDriver(failWith(404));
			await expect(notFound.driver.listFolders()).rejects.toMatchObject({ name: "Invalid" });
		});
	});

	it("close() clears the label cache and is idempotent", async () => {
		const { driver, requests } = makeDriver((url) => {
			if (url.pathname === "/gmail/v1/users/me/messages") return { messages: [] };
			return labelRoutes(url) ?? {};
		});
		await driver.fetch({ folderPath: "INBOX", limit: 5 });
		const warmCount = requests.length;
		await driver.fetch({ folderPath: "INBOX", limit: 5 });
		// Warm cache: no second label-list call.
		expect(requests.filter((r) => new URL(r.url).pathname.endsWith("/labels"))).toHaveLength(1);
		await driver.close();
		await driver.close();
		await driver.fetch({ folderPath: "INBOX", limit: 5 });
		expect(requests.filter((r) => new URL(r.url).pathname.endsWith("/labels"))).toHaveLength(2);
		expect(requests.length).toBeGreaterThan(warmCount);
	});

	describe("fetchAttachment", () => {
		const ATT_PATH = "/gmail/v1/users/me/messages/m1/attachments/att-1";

		it("fetches the addressed part and decodes its bytes", async () => {
			const { driver, requests } = makeDriver((url) => {
				if (url.pathname === ATT_PATH) {
					return { size: 5, data: Buffer.from("hello", "utf8").toString("base64url") };
				}
				return labelRoutes(url) ?? {};
			});
			const out = await driver.fetchAttachment?.({ folderPath: "INBOX", partRef: "m1:att-1" });
			expect(Buffer.from(out?.bytes ?? new Uint8Array()).toString("utf8")).toBe("hello");
			expect(requests.some((r) => new URL(r.url).pathname === ATT_PATH)).toBe(true);
		});

		it("rejects a malformed part reference without calling the API", async () => {
			const { driver, requests } = makeDriver((url) => labelRoutes(url) ?? {});
			await expect(
				driver.fetchAttachment?.({ folderPath: "INBOX", partRef: "no-separator" }),
			).rejects.toThrow(/malformed/);
			expect(requests).toHaveLength(0);
		});

		it("refuses bytes past the cap even when the server under-declares size", async () => {
			const { driver } = makeDriver((url) => {
				if (url.pathname === ATT_PATH) {
					// Declares 1 byte, returns 100 — the cap must follow what arrived.
					return { size: 1, data: Buffer.alloc(100, 0x41).toString("base64url") };
				}
				return labelRoutes(url) ?? {};
			});
			await expect(
				driver.fetchAttachment?.({ folderPath: "INBOX", partRef: "m1:att-1", maxBytes: 10 }),
			).rejects.toThrow(/exceeds/);
		});
	});
});
