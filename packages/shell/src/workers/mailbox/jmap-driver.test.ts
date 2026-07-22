import { FolderRole, MailFlag, MailProtocol } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { FetchWalk } from "../../main/mailbox/mail-driver";
import { makeJmapDriver } from "./jmap-driver";

const SESSION_URL = "https://jmap.example.com/.well-known/jmap";
const API_URL = "https://jmap.example.com/jmap/api";
const DOWNLOAD_URL = "https://jmap.example.com/jmap/download/{accountId}/{blobId}/{type}/{name}";
const ACCOUNT_ID = "acc-1";
const MAIL_CAP = "urn:ietf:params:jmap:mail";

type MethodCall = [string, Record<string, unknown>, string];

type Recorded = { url: string; init: RequestInit | undefined };

const MAILBOXES = [
	{ id: "mb-inbox", name: "Inbox", parentId: null, role: "inbox", unreadEmails: 3 },
	{ id: "mb-sent", name: "Sent", parentId: null, role: "sent", unreadEmails: 0 },
	{ id: "mb-drafts", name: "Drafts", parentId: null, role: "drafts", unreadEmails: 0 },
	{ id: "mb-arch", name: "Archive", parentId: null, role: "archive", unreadEmails: 0 },
	{ id: "mb-2024", name: "2024", parentId: "mb-arch", role: null, unreadEmails: 1 },
];

type FakeEmail = {
	id: string;
	mailbox: string;
	receivedAt: string;
	from: { name?: string; email: string }[];
	to?: { name?: string; email: string }[];
	cc?: { name?: string; email: string }[];
	subject?: string;
	messageId?: string[];
	inReplyTo?: string[];
	references?: string[];
	threadId?: string;
	keywords?: Record<string, boolean>;
	text?: string;
	html?: string;
	attachments?: { blobId: string; name: string; type: string; size: number }[];
};

const EMAILS: FakeEmail[] = [
	{
		id: "e-2",
		mailbox: "mb-inbox",
		receivedAt: "2024-03-02T10:00:00Z",
		from: [{ name: "Dana Lee", email: "dana@x.com" }],
		to: [{ email: "me@x.com" }, { name: "Bo", email: "bo@y.com" }],
		cc: [{ email: "cc@z.com" }],
		subject: "Newer",
		messageId: ["msg-2@x.com"],
		inReplyTo: ["msg-1@x.com"],
		references: ["msg-0@x.com", "msg-1@x.com"],
		threadId: "thread-A",
		keywords: { $flagged: true },
		text: "hello two",
		html: "<p>hello two</p>",
		attachments: [{ blobId: "blob-9", name: "report.pdf", type: "application/pdf", size: 1234 }],
	},
	{
		id: "e-1",
		mailbox: "mb-inbox",
		receivedAt: "2024-03-01T10:00:00Z",
		from: [{ email: "sender@x.com" }],
		subject: "Older",
		messageId: ["msg-1@x.com"],
		threadId: "thread-A",
		keywords: { $seen: true },
		text: "hello one",
	},
];

function sessionResource(): unknown {
	return {
		apiUrl: API_URL,
		downloadUrl: DOWNLOAD_URL,
		accounts: { [ACCOUNT_ID]: { name: "me", isPersonal: true } },
		primaryAccounts: { [MAIL_CAP]: ACCOUNT_ID },
	};
}

function emailObject(e: FakeEmail): Record<string, unknown> {
	const bodyValues: Record<string, { value: string }> = {};
	const textBody: { partId: string; type: string }[] = [];
	const htmlBody: { partId: string; type: string }[] = [];
	if (e.text !== undefined) {
		bodyValues.t = { value: e.text };
		textBody.push({ partId: "t", type: "text/plain" });
	}
	if (e.html !== undefined) {
		bodyValues.h = { value: e.html };
		htmlBody.push({ partId: "h", type: "text/html" });
	}
	return {
		id: e.id,
		blobId: `blob-${e.id}`,
		threadId: e.threadId,
		messageId: e.messageId ?? null,
		inReplyTo: e.inReplyTo ?? null,
		references: e.references ?? null,
		from: e.from,
		to: e.to ?? null,
		cc: e.cc ?? null,
		subject: e.subject ?? null,
		receivedAt: e.receivedAt,
		keywords: e.keywords ?? {},
		textBody,
		htmlBody,
		bodyValues,
		attachments: e.attachments ?? [],
	};
}

/** Minimal in-memory JMAP server: dispatches the batched methodCalls a POST
 *  to `apiUrl` carries. Records what `Email/set`/`EmailSubmission/set` receive
 *  so submit assertions can inspect the envelope. */
function makeServer(overrides?: {
	notCreatedDraft?: boolean;
	dropSubmission?: boolean;
	captured?: { draft?: Record<string, unknown>; submission?: Record<string, unknown> };
}) {
	return function dispatch(body: { methodCalls: MethodCall[] }): unknown {
		const responses: MethodCall[] = [];
		let lastQueryIds: string[] = [];
		for (const [name, args, callId] of body.methodCalls) {
			if (name === "Mailbox/get") {
				responses.push(["Mailbox/get", { accountId: ACCOUNT_ID, list: MAILBOXES }, callId]);
			} else if (name === "Email/query") {
				const filter = (args.filter ?? {}) as { inMailbox?: string; after?: string };
				let list = EMAILS.filter((e) => e.mailbox === filter.inMailbox);
				if (filter.after)
					list = list.filter((e) => Date.parse(e.receivedAt) >= Date.parse(filter.after as string));
				list = list.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
				const position = (args.position as number) ?? 0;
				const limit = (args.limit as number) ?? 50;
				lastQueryIds = list.slice(position, position + limit).map((e) => e.id);
				responses.push([
					"Email/query",
					{ accountId: ACCOUNT_ID, ids: lastQueryIds, position, queryState: "qs" },
					callId,
				]);
			} else if (name === "Email/get") {
				const ids = (args.ids as string[] | undefined) ?? lastQueryIds;
				// Return in reverse to prove the driver re-orders to the query.
				const objs = [...ids]
					.reverse()
					.map((id) => EMAILS.find((e) => e.id === id))
					.filter((e): e is FakeEmail => e !== undefined)
					.map(emailObject);
				responses.push(["Email/get", { accountId: ACCOUNT_ID, list: objs }, callId]);
			} else if (name === "Email/set") {
				const create = (args.create ?? {}) as Record<string, Record<string, unknown>>;
				if (overrides?.captured && create.draft) overrides.captured.draft = create.draft;
				if (overrides?.notCreatedDraft) {
					responses.push([
						"Email/set",
						{ accountId: ACCOUNT_ID, notCreated: { draft: { type: "invalidProperties" } } },
						callId,
					]);
				} else {
					responses.push([
						"Email/set",
						{ accountId: ACCOUNT_ID, created: { draft: { id: "email-new", blobId: "b-new" } } },
						callId,
					]);
				}
			} else if (name === "EmailSubmission/set") {
				if (overrides?.captured) overrides.captured.submission = args;
				if (overrides?.dropSubmission) {
					responses.push([
						"EmailSubmission/set",
						{ accountId: ACCOUNT_ID, notCreated: { sub: { type: "forbiddenFrom" } } },
						callId,
					]);
				} else {
					responses.push([
						"EmailSubmission/set",
						{ accountId: ACCOUNT_ID, created: { sub: { id: "sub-1" } } },
						callId,
					]);
				}
			}
		}
		return { methodResponses: responses, sessionState: "s" };
	};
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

function makeDriver(
	handler: RouteHandler,
	opts?: { now?: () => number },
): { driver: ReturnType<typeof makeJmapDriver>; requests: Recorded[] } {
	const { impl, requests } = stubFetch(handler);
	const driver = makeJmapDriver({
		credentials: { secret: "tok-abc" },
		sessionUrl: SESSION_URL,
		fetchImpl: impl,
		...(opts?.now ? { now: opts.now } : {}),
	});
	return { driver, requests };
}

/** The common happy-path router: session + api dispatch. */
function router(server = makeServer()): RouteHandler {
	return (url, init) => {
		if (url.href === SESSION_URL) return sessionResource();
		if (url.href === API_URL) {
			const body = JSON.parse(String(init?.body ?? "{}")) as { methodCalls: MethodCall[] };
			return server(body);
		}
		return new Response("not found", { status: 404 });
	};
}

describe("makeJmapDriver", () => {
	it("exposes the jmap protocol", () => {
		const { driver } = makeDriver(router());
		expect(driver.protocol).toBe(MailProtocol.Jmap);
	});

	it("sends the bearer token on session + api requests", async () => {
		const { driver, requests } = makeDriver(router());
		await driver.listFolders();
		expect(requests.length).toBeGreaterThanOrEqual(2);
		for (const req of requests) {
			expect((req.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok-abc");
		}
	});

	it("maps mailbox roles and builds hierarchical paths", async () => {
		const { driver } = makeDriver(router());
		const folders = await driver.listFolders();
		const byPath = new Map(folders.map((f) => [f.path, f]));
		expect(byPath.get("Inbox")?.role).toBe(FolderRole.Inbox);
		expect(byPath.get("Sent")?.role).toBe(FolderRole.Sent);
		expect(byPath.get("Archive")?.role).toBe(FolderRole.Archive);
		expect(byPath.get("Inbox")?.unreadCount).toBe(3);
		// A null-role nested mailbox → Custom, addressed by full path.
		expect(byPath.get("Archive/2024")?.role).toBe(FolderRole.Custom);
	});

	it("fetches a page in query order and projects every field", async () => {
		const { driver } = makeDriver(router());
		const result = await driver.fetch({ folderPath: "Inbox", limit: 50 });
		expect(result.messages.map((m) => m.messageId)).toEqual(["<msg-2@x.com>", "<msg-1@x.com>"]);
		const newer = result.messages[0];
		expect(newer?.from).toBe("Dana Lee <dana@x.com>");
		expect(newer?.to).toBe("me@x.com, Bo <bo@y.com>");
		expect(newer?.cc).toBe("cc@z.com");
		expect(newer?.subject).toBe("Newer");
		expect(newer?.bodyText).toBe("hello two");
		expect(newer?.bodyHtml).toBe("<p>hello two</p>");
		expect(newer?.receivedAt).toBe(Date.parse("2024-03-02T10:00:00Z"));
		expect(newer?.providerThreadId).toBe("thread-A");
		expect(newer?.inReplyTo).toBe("<msg-1@x.com>");
		expect(newer?.references).toEqual(["<msg-0@x.com>", "<msg-1@x.com>"]);
		expect(newer?.attachmentParts).toEqual([
			{ partRef: "blob-9", filename: "report.pdf", mimeType: "application/pdf", sizeBytes: 1234 },
		]);
	});

	it("derives unread from the absence of $seen and flagged from $flagged", async () => {
		const { driver } = makeDriver(router());
		const result = await driver.fetch({ folderPath: "Inbox", limit: 50 });
		const [newer, older] = result.messages;
		// e-2 has $flagged but no $seen → Unread + Flagged.
		expect(newer?.flags).toEqual(expect.arrayContaining([MailFlag.Unread, MailFlag.Flagged]));
		// e-1 has $seen → read (no Unread flag).
		expect(older?.flags).not.toContain(MailFlag.Unread);
	});

	it("bounds a forward walk by sinceMs but omits the filter on backfill", async () => {
		const { driver, requests } = makeDriver(router());
		const since = Date.parse("2024-03-02T00:00:00Z");
		const fwd = await driver.fetch({ folderPath: "Inbox", limit: 50, sinceMs: since });
		expect(fwd.messages.map((m) => m.messageId)).toEqual(["<msg-2@x.com>"]);
		const fwdBody = JSON.parse(String(requests.at(-1)?.init?.body));
		expect(fwdBody.methodCalls[0][1].filter.after).toBe(new Date(since).toISOString());

		const back = await driver.fetch({
			folderPath: "Inbox",
			limit: 50,
			sinceMs: since,
			walk: FetchWalk.Backfill,
		});
		expect(back.messages.length).toBe(2);
		const backBody = JSON.parse(String(requests.at(-1)?.init?.body));
		expect(backBody.methodCalls[0][1].filter.after).toBeUndefined();
	});

	it("emits a resume cursor only on a full page", async () => {
		const { driver } = makeDriver(router());
		const full = await driver.fetch({ folderPath: "Inbox", limit: 2 });
		expect(full.nextCursor).toBe("2");
		const page2 = await driver.fetch({ folderPath: "Inbox", limit: 2, cursor: "2" });
		expect(page2.messages.length).toBe(0);
		expect(page2.nextCursor).toBeUndefined();
	});

	it("downloads an attachment by blobId and enforces the size cap", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const { driver, requests } = makeDriver((url, init) => {
			if (url.href === SESSION_URL) return sessionResource();
			if (url.pathname.startsWith("/jmap/download/")) {
				return new Response(bytes, { status: 200 });
			}
			return router()(url, init);
		});
		const fetchAttachment = driver.fetchAttachment;
		if (!fetchAttachment) throw new Error("jmap driver must expose fetchAttachment");
		const out = await fetchAttachment({ folderPath: "Inbox", partRef: "blob-9" });
		expect(Array.from(out.bytes)).toEqual([1, 2, 3, 4]);
		const dl = requests.find((r) => r.url.includes("/jmap/download/"));
		expect(dl?.url).toContain("/blob-9/");
		expect(dl?.url).toContain(`/${ACCOUNT_ID}/`);

		await expect(
			fetchAttachment({ folderPath: "Inbox", partRef: "blob-9", maxBytes: 2 }),
		).rejects.toThrow(/exceeds 2 bytes/);
	});

	it("submits via Email/set + EmailSubmission/set with a full envelope", async () => {
		const captured: { draft?: Record<string, unknown>; submission?: Record<string, unknown> } = {};
		const { driver } = makeDriver(router(makeServer({ captured })), { now: () => 1_700_000_000_000 });
		const out = await driver.submit({
			from: "me@x.com",
			to: ["a@y.com", "b@z.com"],
			cc: ["c@w.com"],
			subject: "Hi",
			bodyText: "body",
			submissionId: "sub-123",
		});
		expect(out.messageId).toBe("<sub-123@brainstorm.local>");
		expect(out.receivedAt).toBe(1_700_000_000_000);
		if (!captured.submission || !captured.draft) throw new Error("submit did not reach the server");
		const create = captured.submission.create as {
			sub: { envelope: { mailFrom: { email: string }; rcptTo: { email: string }[] } };
		};
		const envelope = create.sub.envelope;
		expect(envelope.mailFrom.email).toBe("me@x.com");
		expect(envelope.rcptTo.map((r) => r.email)).toEqual(["a@y.com", "b@z.com", "c@w.com"]);
		// The draft files into Drafts with the $draft keyword.
		expect((captured.draft.mailboxIds as Record<string, boolean>)["mb-drafts"]).toBe(true);
	});

	it("fails closed on a rejected draft or submission", async () => {
		const { driver: d1 } = makeDriver(router(makeServer({ notCreatedDraft: true })));
		await expect(
			d1.submit({ from: "me@x.com", to: ["a@y.com"], submissionId: "s1" }),
		).rejects.toThrow(/draft rejected/);
		const { driver: d2 } = makeDriver(router(makeServer({ dropSubmission: true })));
		await expect(
			d2.submit({ from: "me@x.com", to: ["a@y.com"], submissionId: "s2" }),
		).rejects.toThrow(/submission failed/);
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
			if (url.href === SESSION_URL) return new Response("nope", { status: 401 });
			return new Response("x", { status: 500 });
		});
		await expect(denied.driver.listFolders()).rejects.toMatchObject({ name: "Denied" });

		const unavailable = makeDriver((url, init) => {
			if (url.href === SESSION_URL) return sessionResource();
			if (url.href === API_URL) return new Response("boom", { status: 500 });
			return router()(url, init);
		});
		await expect(unavailable.driver.listFolders()).rejects.toMatchObject({ name: "Unavailable" });
	});

	it("re-fetches the session after close()", async () => {
		const { driver, requests } = makeDriver(router());
		await driver.listFolders();
		const sessionHitsBefore = requests.filter((r) => r.url === SESSION_URL).length;
		await driver.close();
		await driver.listFolders();
		const sessionHitsAfter = requests.filter((r) => r.url === SESSION_URL).length;
		expect(sessionHitsAfter).toBe(sessionHitsBefore + 1);
	});
});
