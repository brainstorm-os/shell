import { Buffer } from "node:buffer";
import { FolderRole, MailFlag, MailProtocol } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { FetchWalk } from "../../main/mailbox/mail-driver";
import { makeMsGraphDriver } from "./ms-graph-driver";

const BASE_URL = "https://graph.test/v1.0";

type Recorded = { url: string; init: RequestInit | undefined };

const FOLDERS = [
	{
		id: "f-inbox",
		displayName: "Inbox",
		wellKnownName: "inbox",
		unreadItemCount: 5,
		parentFolderId: "root",
	},
	{
		id: "f-sent",
		displayName: "Sent Items",
		wellKnownName: "sentitems",
		unreadItemCount: 0,
		parentFolderId: "root",
	},
	{
		id: "f-arch",
		displayName: "Archive",
		wellKnownName: "archive",
		unreadItemCount: 0,
		parentFolderId: "root",
	},
	{
		id: "f-proj",
		displayName: "Projects",
		wellKnownName: null,
		unreadItemCount: 2,
		parentFolderId: "f-arch",
	},
];

const MESSAGES = [
	{
		id: "m-2",
		internetMessageId: "<msg-2@x.com>",
		subject: "Newer",
		from: { emailAddress: { name: "Dana Lee", address: "dana@x.com" } },
		toRecipients: [
			{ emailAddress: { address: "me@x.com" } },
			{ emailAddress: { name: "Bo", address: "bo@y.com" } },
		],
		ccRecipients: [{ emailAddress: { address: "cc@z.com" } }],
		receivedDateTime: "2024-03-02T10:00:00Z",
		body: { contentType: "html", content: "<p>hi two</p>" },
		isRead: false,
		flag: { flagStatus: "flagged" },
		conversationId: "conv-A",
		internetMessageHeaders: [
			{ name: "In-Reply-To", value: "<msg-1@x.com>" },
			{ name: "References", value: "<msg-0@x.com> <msg-1@x.com>" },
		],
		attachments: [
			{ id: "a-9", name: "report.pdf", contentType: "application/pdf", size: 1234, isInline: false },
			{ id: "a-inline", name: "logo.png", contentType: "image/png", size: 10, isInline: true },
		],
	},
	{
		id: "m-1",
		internetMessageId: "<msg-1@x.com>",
		subject: "Older",
		from: { emailAddress: { address: "sender@x.com" } },
		receivedDateTime: "2024-03-01T10:00:00Z",
		body: { contentType: "text", content: "hi one" },
		isRead: true,
		conversationId: "conv-A",
		attachments: [],
	},
];

function messagesPage(url: URL): unknown {
	const top = Number(url.searchParams.get("$top") ?? "10");
	const skip = Number(url.searchParams.get("$skip") ?? "0");
	const filter = url.searchParams.get("$filter");
	let list = [...MESSAGES];
	if (filter) {
		const m = filter.match(/receivedDateTime ge (.+)$/);
		if (m?.[1]) {
			const since = Date.parse(m[1]);
			list = list.filter((x) => Date.parse(x.receivedDateTime) >= since);
		}
	}
	list = list.sort((a, b) => Date.parse(b.receivedDateTime) - Date.parse(a.receivedDateTime));
	const value = list.slice(skip, skip + top);
	const out: Record<string, unknown> = { value };
	if (skip + top < list.length) {
		const next = new URL(url.href);
		next.searchParams.set("$skip", String(skip + top));
		out["@odata.nextLink"] = next.href;
	}
	return out;
}

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

/** The default happy-path router: folders, messages, attachment bytes. */
function router(): RouteHandler {
	return (url) => {
		if (url.pathname.endsWith("/mailFolders")) return { value: FOLDERS };
		if (url.pathname.endsWith("/messages")) return messagesPage(url);
		if (url.pathname.includes("/attachments/") && url.pathname.endsWith("/$value")) {
			return new Response(new Uint8Array([9, 8, 7]), { status: 200 });
		}
		return new Response("not found", { status: 404 });
	};
}

function makeDriver(
	handler: RouteHandler,
	opts?: { now?: () => number },
): { driver: ReturnType<typeof makeMsGraphDriver>; requests: Recorded[] } {
	const { impl, requests } = stubFetch(handler);
	const driver = makeMsGraphDriver({
		credentials: { secret: "tok-xyz" },
		baseUrl: BASE_URL,
		fetchImpl: impl,
		...(opts?.now ? { now: opts.now } : {}),
	});
	return { driver, requests };
}

describe("makeMsGraphDriver", () => {
	it("exposes the ms-graph protocol", () => {
		const { driver } = makeDriver(router());
		expect(driver.protocol).toBe(MailProtocol.MsGraph);
	});

	it("sends the bearer token on every request", async () => {
		const { driver, requests } = makeDriver(router());
		await driver.listFolders();
		expect(requests.length).toBeGreaterThan(0);
		for (const req of requests) {
			expect((req.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok-xyz");
		}
	});

	it("maps well-known folder names and builds hierarchical paths", async () => {
		const { driver } = makeDriver(router());
		const folders = await driver.listFolders();
		const byPath = new Map(folders.map((f) => [f.path, f]));
		expect(byPath.get("Inbox")?.role).toBe(FolderRole.Inbox);
		expect(byPath.get("Sent Items")?.role).toBe(FolderRole.Sent);
		expect(byPath.get("Archive")?.role).toBe(FolderRole.Archive);
		expect(byPath.get("Inbox")?.unreadCount).toBe(5);
		// A null well-known name nested under Archive → Custom, full path.
		expect(byPath.get("Archive/Projects")?.role).toBe(FolderRole.Custom);
	});

	it("fetches and projects every field", async () => {
		const { driver } = makeDriver(router());
		const result = await driver.fetch({ folderPath: "Inbox", limit: 50 });
		expect(result.messages.map((m) => m.messageId)).toEqual(["<msg-2@x.com>", "<msg-1@x.com>"]);
		const newer = result.messages[0];
		expect(newer?.from).toBe("Dana Lee <dana@x.com>");
		expect(newer?.to).toBe("me@x.com, Bo <bo@y.com>");
		expect(newer?.cc).toBe("cc@z.com");
		expect(newer?.subject).toBe("Newer");
		expect(newer?.bodyHtml).toBe("<p>hi two</p>");
		expect(newer?.bodyText).toBeUndefined();
		expect(newer?.receivedAt).toBe(Date.parse("2024-03-02T10:00:00Z"));
		expect(newer?.providerThreadId).toBe("conv-A");
		expect(newer?.inReplyTo).toBe("<msg-1@x.com>");
		expect(newer?.references).toEqual(["<msg-0@x.com>", "<msg-1@x.com>"]);
		// Inline attachment dropped; the real one carries a message::attachment ref.
		expect(newer?.attachmentParts).toEqual([
			{ partRef: "m-2::a-9", filename: "report.pdf", mimeType: "application/pdf", sizeBytes: 1234 },
		]);
		const older = result.messages[1];
		expect(older?.bodyText).toBe("hi one");
		expect(older?.flags).not.toContain(MailFlag.Unread);
	});

	it("derives unread from isRead:false and flagged from flagStatus", async () => {
		const { driver } = makeDriver(router());
		const result = await driver.fetch({ folderPath: "Inbox", limit: 50 });
		expect(result.messages[0]?.flags).toEqual(
			expect.arrayContaining([MailFlag.Unread, MailFlag.Flagged]),
		);
	});

	it("bounds a forward walk by sinceMs but omits the filter on backfill", async () => {
		const { driver, requests } = makeDriver(router());
		const since = Date.parse("2024-03-02T00:00:00Z");
		const fwd = await driver.fetch({ folderPath: "Inbox", limit: 50, sinceMs: since });
		expect(fwd.messages.map((m) => m.messageId)).toEqual(["<msg-2@x.com>"]);
		expect(requests.at(-1)?.url).toContain("%24filter=");

		const back = await driver.fetch({
			folderPath: "Inbox",
			limit: 50,
			sinceMs: since,
			walk: FetchWalk.Backfill,
		});
		expect(back.messages.length).toBe(2);
		expect(requests.at(-1)?.url).not.toContain("%24filter=");
	});

	it("follows the opaque nextLink cursor verbatim", async () => {
		const { driver, requests } = makeDriver(router());
		const page1 = await driver.fetch({ folderPath: "Inbox", limit: 1 });
		expect(page1.messages.map((m) => m.messageId)).toEqual(["<msg-2@x.com>"]);
		expect(page1.nextCursor).toBeDefined();
		const page2 = await driver.fetch({
			folderPath: "Inbox",
			limit: 1,
			...(page1.nextCursor !== undefined ? { cursor: page1.nextCursor } : {}),
		});
		expect(page2.messages.map((m) => m.messageId)).toEqual(["<msg-1@x.com>"]);
		expect(page2.nextCursor).toBeUndefined();
		// The cursor GET hit the nextLink URL directly (no fresh folder resolve).
		expect(requests.at(-1)?.url).toBe(page1.nextCursor);
	});

	it("downloads an attachment via $value and enforces the size cap", async () => {
		const { driver, requests } = makeDriver(router());
		const fetchAttachment = driver.fetchAttachment;
		if (!fetchAttachment) throw new Error("ms-graph driver must expose fetchAttachment");
		const out = await fetchAttachment({ folderPath: "Inbox", partRef: "m-2::a-9" });
		expect(Array.from(out.bytes)).toEqual([9, 8, 7]);
		const dl = requests.find((r) => r.url.includes("/attachments/"));
		expect(dl?.url).toContain("/messages/m-2/attachments/a-9/$value");

		await expect(
			fetchAttachment({ folderPath: "Inbox", partRef: "m-2::a-9", maxBytes: 2 }),
		).rejects.toThrow(/exceeds 2 bytes/);

		await expect(fetchAttachment({ folderPath: "Inbox", partRef: "no-separator" })).rejects.toThrow(
			/malformed attachment/,
		);
	});

	it("submits a base64 MIME message through sendMail", async () => {
		let sendBody: string | undefined;
		let sendInit: RequestInit | undefined;
		const { driver } = makeDriver(
			(url, init) => {
				if (url.pathname.endsWith("/sendMail")) {
					sendBody = String(init?.body ?? "");
					sendInit = init;
					return new Response("", { status: 202 });
				}
				return router()(url, init);
			},
			{ now: () => 1_700_000_000_000 },
		);
		const out = await driver.submit({
			from: "me@x.com",
			to: ["a@y.com"],
			cc: ["c@w.com"],
			subject: "Hi",
			bodyText: "body",
			submissionId: "sub-123",
		});
		expect(out.messageId).toBe("<sub-123@brainstorm.local>");
		expect(out.receivedAt).toBe(1_700_000_000_000);
		expect((sendInit?.headers as Record<string, string>)["Content-Type"]).toBe("text/plain");
		const mime = Buffer.from(sendBody ?? "", "base64").toString("utf8");
		expect(mime).toContain("Message-ID: <sub-123@brainstorm.local>");
		expect(mime).toContain("To: a@y.com");
		expect(mime).toContain("Cc: c@w.com");
	});

	it("rejects header injection in an outbound field", async () => {
		const { driver } = makeDriver(router());
		await expect(
			driver.submit({
				from: "me@x.com",
				to: ["a@y.com"],
				subject: "line\r\nBcc: evil@x.com",
				submissionId: "s3",
			}),
		).rejects.toThrow(/line break/);
	});

	it("maps HTTP status onto driver error kinds", async () => {
		const denied = makeDriver((url) => {
			if (url.pathname.endsWith("/mailFolders")) return new Response("no", { status: 403 });
			return new Response("x", { status: 500 });
		});
		await expect(denied.driver.listFolders()).rejects.toMatchObject({ name: "Denied" });

		const unavailable = makeDriver((url) => {
			if (url.pathname.endsWith("/mailFolders")) return new Response("boom", { status: 503 });
			return new Response("x", { status: 500 });
		});
		await expect(unavailable.driver.listFolders()).rejects.toMatchObject({ name: "Unavailable" });
	});

	it("clears the folder cache on close()", async () => {
		const { driver, requests } = makeDriver(router());
		await driver.listFolders();
		const before = requests.filter((r) => r.url.includes("/mailFolders")).length;
		await driver.close();
		await driver.listFolders();
		const after = requests.filter((r) => r.url.includes("/mailFolders")).length;
		expect(after).toBe(before + 1);
	});
});
