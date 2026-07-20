import {
	AuthKind,
	CONNECTOR_TYPE_URL,
	FolderRole,
	MAIL_ACCOUNT_TYPE_URL,
	MAIL_FOLDER_TYPE_URL,
	MailProtocol,
	SyncWindow,
} from "@brainstorm/sdk-types";
import { describe, expect, it, vi } from "vitest";
import type { Envelope } from "../../ipc/envelope";
import type { ProviderConfig } from "../connectors/oauth-broker";
import type { RedirectProvider } from "../connectors/oauth-redirect";
import type { EntityRow } from "../storage/entities-repo/entities-repo";
import type { MailDriver } from "./mail-driver";
import {
	MAILBOX_APP_ID,
	MAIL_MANAGE_CAP,
	type MailServiceDeps,
	createMailService,
	makeMailServiceHandler,
} from "./mailbox-service";

const EMAIL_TYPE = "brainstorm/Email/v1";

function envelope(method: string, arg: unknown, app = MAILBOX_APP_ID): Envelope {
	return { v: 1, msg: "m1", app, service: "mail", method, args: [arg], caps: [] };
}

/** Minimal in-memory entity store backing both the repo reads and the
 *  `callEntities` writes the service performs. */
function makeFakeStore() {
	const rows = new Map<string, EntityRow>();
	let seq = 0;
	const insert = (type: string, properties: Record<string, unknown>): { id: string } => {
		seq += 1;
		const id = `e${seq}`;
		rows.set(id, { id, type, properties } as EntityRow);
		return { id };
	};
	const repo = {
		get: (id: string) => rows.get(id) ?? null,
		idsByTypes: (types: readonly string[]) =>
			[...rows.values()].filter((r) => types.includes(r.type)).map((r) => r.id),
		listIdsWithProperty: (key: string, value: string) =>
			[...rows.values()].filter((r) => r.properties[key] === value).map((r) => r.id),
	};
	const callEntities = vi.fn((app: string, method: string, arg: unknown): Promise<unknown> => {
		const a = arg as {
			id?: string;
			type?: string;
			properties: Record<string, unknown>;
			patch?: Record<string, unknown>;
		};
		if (method === "create" && a.type) return Promise.resolve(insert(a.type, a.properties));
		if (method === "update" && a.id) {
			// The entities service reads `patch` (the SDK wire shape) — the
			// fake mirrors that so a `properties`-shaped no-op can't pass.
			const row = rows.get(a.id);
			if (row) Object.assign(row.properties, a.patch);
			return Promise.resolve(undefined);
		}
		throw new Error(`unexpected callEntities ${method}`);
	});
	return { rows, insert, repo, callEntities };
}

const profileResponse = {
	status: 200,
	headers: { "content-type": "application/json" },
	body: new TextEncoder().encode(JSON.stringify({ emailAddress: "me@example.com" })),
	finalUrl: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
};

const fakeRedirect: RedirectProvider = {
	start: () =>
		Promise.resolve({
			redirectUri: "http://127.0.0.1:50000/cb",
			waitForCode: () => Promise.resolve("code"),
			close: () => {},
		}),
};

function makeFakeDriver(overrides: Partial<MailDriver> = {}): MailDriver {
	return {
		protocol: MailProtocol.GmailApi,
		listFolders: () => Promise.resolve([{ path: "INBOX", role: FolderRole.Inbox }]),
		fetch: () =>
			Promise.resolve({
				messages: [
					{
						messageId: "<msg-1@mail.gmail.com>",
						from: "Dana Lee <dana@x.com>",
						to: "me@example.com",
						subject: "hello",
						receivedAt: 1_700_000_000_000,
						bodyText: "hi",
						flags: [],
						folderPath: "INBOX",
					},
				],
			}),
		submit: () => Promise.reject(new Error("not under test")),
		close: () => Promise.resolve(),
		...overrides,
	};
}

function makeDeps(store = makeFakeStore()) {
	const authorize = vi.fn().mockResolvedValue({ accountId: "conn-acc-1" });
	const getValidAccessToken = vi.fn().mockResolvedValue("ACCESS_TOKEN");
	const revoke = vi.fn().mockResolvedValue(undefined);
	const driver = makeFakeDriver();
	const closeSpy = vi.spyOn(driver, "close");
	const connect = vi.fn().mockResolvedValue(undefined);
	const deps: MailServiceDeps = {
		broker: { authorize, getValidAccessToken, revoke } as unknown as MailServiceDeps["broker"],
		redirectProvider: fakeRedirect,
		egress: vi.fn().mockResolvedValue(profileResponse),
		getRepo: () =>
			Promise.resolve(store.repo as unknown as Awaited<ReturnType<MailServiceDeps["getRepo"]>>),
		callEntities: store.callEntities,
		transport: { connect, driverFor: () => driver },
		now: () => 1_700_000_000_000,
	};
	return { deps, store, authorize, getValidAccessToken, revoke, connect, driver, closeSpy };
}

describe("mail.connectGmail", () => {
	it("creates the Connector row, runs OAuth with the client secret, creates a linked MailAccount", async () => {
		const { deps, store, authorize } = makeDeps();
		const handler = makeMailServiceHandler(deps);
		const result = (await handler(
			envelope("connectGmail", {
				clientId: "cid.apps.googleusercontent.com",
				clientSecret: "GOCSPX-x",
				label: "Work",
			}),
		)) as { accountId: string; address: string };

		expect(result.address).toBe("me@example.com");
		const connector = [...store.rows.values()].find((r) => r.type === CONNECTOR_TYPE_URL);
		expect(connector?.properties.connectorAppId).toBe(MAILBOX_APP_ID);
		expect(connector?.properties.egressOrigins).toContain("https://oauth2.googleapis.com");
		// The secret never lands on any entity.
		for (const row of store.rows.values()) {
			expect(JSON.stringify(row.properties)).not.toContain("GOCSPX");
		}
		const authInput = authorize.mock.calls[0]?.[0] as {
			clientSecret?: string;
			provider: ProviderConfig;
		};
		expect(authInput.clientSecret).toBe("GOCSPX-x");
		expect(authInput.provider.extraAuthParams?.access_type).toBe("offline");

		const account = store.rows.get(result.accountId);
		expect(account?.type).toBe(MAIL_ACCOUNT_TYPE_URL);
		expect(account?.properties.protocol).toBe(MailProtocol.GmailApi);
		expect(account?.properties.authKind).toBe(AuthKind.OAuth2);
		expect(account?.properties.connectorAccountRef).toBe("conn-acc-1");
	});

	it("reuses the existing Connector row and refreshes its client id", async () => {
		const { deps, store } = makeDeps();
		store.insert(CONNECTOR_TYPE_URL, {
			connectorAppId: MAILBOX_APP_ID,
			oauth: { clientId: "old-cid" },
		});
		const handler = makeMailServiceHandler(deps);
		await handler(envelope("connectGmail", { clientId: "new-cid" }));
		const connectors = [...store.rows.values()].filter((r) => r.type === CONNECTOR_TYPE_URL);
		expect(connectors).toHaveLength(1);
		expect((connectors[0]?.properties.oauth as { clientId: string }).clientId).toBe("new-cid");
	});

	it("is Denied without the mail.manage capability", async () => {
		const { deps } = makeDeps();
		deps.getLedger = () =>
			Promise.resolve({ has: () => false } as unknown as Awaited<
				ReturnType<NonNullable<MailServiceDeps["getLedger"]>>
			>);
		const handler = makeMailServiceHandler(deps);
		await expect(handler(envelope("connectGmail", { clientId: "cid" }))).rejects.toMatchObject({
			name: "Denied",
		});
	});
});

describe("mail.loadOlder (Mailbox-12)", () => {
	function seedAccount(store: ReturnType<typeof makeFakeStore>): { id: string } {
		store.insert(CONNECTOR_TYPE_URL, {
			connectorAppId: MAILBOX_APP_ID,
			oauth: { clientId: "cid" },
		});
		return store.insert(MAIL_ACCOUNT_TYPE_URL, {
			address: "me@example.com",
			protocol: MailProtocol.GmailApi,
			authKind: AuthKind.OAuth2,
			syncWindow: SyncWindow.Days30,
			enabled: true,
			connectorAccountRef: "conn-acc-1",
		});
	}

	it("walks each stored folder one backfill page, persists the cursor state, closes the driver", async () => {
		const fetchSpecs: unknown[] = [];
		const store = makeFakeStore();
		const { deps } = makeDeps(store);
		const driver = makeFakeDriver({
			fetch: (spec) => {
				fetchSpecs.push(spec);
				return Promise.resolve({
					messages: [
						{
							messageId: "<old-1@mail.gmail.com>",
							from: "Old Sender <old@x.com>",
							to: "me@example.com",
							subject: "from the archive",
							receivedAt: 1_600_000_000_000,
							bodyText: "ancient",
							flags: [],
							folderPath: "INBOX",
						},
					],
				});
			},
		});
		const closeSpy = vi.spyOn(driver, "close");
		(deps.transport as { driverFor: unknown }).driverFor = () => driver;
		const account = seedAccount(store);
		// A stored folder row from a prior sync — the walk resumes over these.
		store.insert(MAIL_FOLDER_TYPE_URL, {
			accountRef: account.id,
			path: "INBOX",
			role: "inbox",
			unreadCount: 0,
		});
		const handler = makeMailServiceHandler(deps);
		const result = (await handler(envelope("loadOlder", { accountRef: account.id }))) as {
			created: number;
			done: boolean;
		};
		expect(result.created).toBe(1);
		// Fake returned no nextCursor ⇒ folder exhausted ⇒ done.
		expect(result.done).toBe(true);
		expect(fetchSpecs[0]).toMatchObject({ folderPath: "INBOX", walk: "backfill" });
		const folder = [...store.rows.values()].find((r) => r.type === MAIL_FOLDER_TYPE_URL);
		expect(folder?.properties.backfillDone).toBe(true);
		const email = [...store.rows.values()].find(
			(r) => r.type === EMAIL_TYPE && r.properties.messageId === "<old-1@mail.gmail.com>",
		);
		expect(email).toBeDefined();
		expect(closeSpy).toHaveBeenCalled();
	});

	it("shares the per-account latch with syncNow", async () => {
		const store = makeFakeStore();
		const { deps, driver } = makeDeps(store);
		const account = seedAccount(store);
		store.insert(MAIL_FOLDER_TYPE_URL, {
			accountRef: account.id,
			path: "INBOX",
			role: "inbox",
			unreadCount: 0,
		});
		let release: (() => void) | undefined;
		driver.fetch = () =>
			new Promise((resolve) => {
				release = () => resolve({ messages: [] });
			});
		const handler = makeMailServiceHandler(deps);
		const first = handler(envelope("syncNow", { accountRef: account.id }));
		await new Promise((r) => setTimeout(r, 0));
		await expect(handler(envelope("loadOlder", { accountRef: account.id }))).rejects.toMatchObject({
			message: expect.stringContaining("already running"),
		});
		release?.();
		await first;
	});
});

describe("mail.syncNow", () => {
	function seedAccount(store: ReturnType<typeof makeFakeStore>) {
		store.insert(CONNECTOR_TYPE_URL, {
			connectorAppId: MAILBOX_APP_ID,
			oauth: { clientId: "cid" },
		});
		return store.insert(MAIL_ACCOUNT_TYPE_URL, {
			address: "me@example.com",
			protocol: MailProtocol.GmailApi,
			authKind: AuthKind.OAuth2,
			syncWindow: SyncWindow.Days30,
			enabled: true,
			connectorAccountRef: "conn-acc-1",
		});
	}

	it("injects a fresh token into the worker, runs the engine, projects entities, closes the driver", async () => {
		const { deps, store, getValidAccessToken, connect, closeSpy } = makeDeps();
		const account = seedAccount(store);
		const handler = makeMailServiceHandler(deps);
		const result = (await handler(envelope("syncNow", { accountRef: account.id }))) as {
			folders: number;
			created: number;
		};
		expect(getValidAccessToken).toHaveBeenCalledWith(
			expect.objectContaining({ accountId: "conn-acc-1", connectorAppId: MAILBOX_APP_ID }),
		);
		expect(connect).toHaveBeenCalledWith({
			accountId: account.id,
			protocol: MailProtocol.GmailApi,
			credentials: { secret: "ACCESS_TOKEN" },
		});
		expect(result.folders).toBe(1);
		expect(result.created).toBe(1);
		const email = [...store.rows.values()].find((r) => r.type === EMAIL_TYPE);
		expect(email?.properties.messageId).toBe("<msg-1@mail.gmail.com>");
		expect(closeSpy).toHaveBeenCalled();
	});

	it("rejects a concurrent sync of the same account (per-account latch)", async () => {
		const { deps, store, driver } = makeDeps();
		const account = seedAccount(store);
		let release: (() => void) | undefined;
		driver.listFolders = () =>
			new Promise((resolve) => {
				release = () => resolve([{ path: "INBOX", role: FolderRole.Inbox }]);
			});
		const handler = makeMailServiceHandler(deps);
		const first = handler(envelope("syncNow", { accountRef: account.id }));
		// Wait until the first sync is actually parked inside the driver, then
		// a second call must fail closed instead of racing the engine's
		// find-then-create upserts.
		await vi.waitFor(() => {
			if (!release) throw new Error("first sync not parked yet");
		});
		await expect(handler(envelope("syncNow", { accountRef: account.id }))).rejects.toMatchObject({
			name: "Unavailable",
		});
		release?.();
		await first;
		// Latch released — a follow-up sync runs again.
		driver.listFolders = () => Promise.resolve([{ path: "INBOX", role: FolderRole.Inbox }]);
		await expect(handler(envelope("syncNow", { accountRef: account.id }))).resolves.toMatchObject({
			accountRef: account.id,
		});
	});

	it("closes the worker driver even when the engine throws", async () => {
		const { deps, store, driver, closeSpy } = makeDeps();
		const account = seedAccount(store);
		driver.listFolders = () => Promise.reject(new Error("boom"));
		const handler = makeMailServiceHandler(deps);
		await expect(handler(envelope("syncNow", { accountRef: account.id }))).rejects.toThrow("boom");
		expect(closeSpy).toHaveBeenCalled();
	});

	it("rejects an unknown account, a host-less imap account, and an unimplemented protocol", async () => {
		const { deps, store } = makeDeps();
		const handler = makeMailServiceHandler(deps);
		await expect(handler(envelope("syncNow", { accountRef: "nope" }))).rejects.toMatchObject({
			name: "Invalid",
		});
		const imap = store.insert(MAIL_ACCOUNT_TYPE_URL, {
			address: "a@b.c",
			protocol: MailProtocol.Imap,
			enabled: true,
		});
		await expect(handler(envelope("syncNow", { accountRef: imap.id }))).rejects.toMatchObject({
			name: "Invalid",
		});
		const graph = store.insert(MAIL_ACCOUNT_TYPE_URL, {
			address: "a@b.c",
			protocol: MailProtocol.MsGraph,
			enabled: true,
		});
		await expect(handler(envelope("syncNow", { accountRef: graph.id }))).rejects.toMatchObject({
			name: "Unavailable",
		});
	});
});

describe("mail.disconnect", () => {
	it("revokes the connector account token and disables the mail account", async () => {
		const { deps, store, revoke } = makeDeps();
		store.insert(CONNECTOR_TYPE_URL, {
			connectorAppId: MAILBOX_APP_ID,
			oauth: { clientId: "cid" },
		});
		const account = store.insert(MAIL_ACCOUNT_TYPE_URL, {
			address: "me@example.com",
			protocol: MailProtocol.GmailApi,
			enabled: true,
			connectorAccountRef: "conn-acc-1",
		});
		const handler = makeMailServiceHandler(deps);
		const result = await handler(envelope("disconnect", { accountRef: account.id }));
		expect(result).toEqual({ ok: true });
		expect(revoke).toHaveBeenCalledWith({
			connectorAppId: MAILBOX_APP_ID,
			accountId: "conn-acc-1",
		});
		expect(store.rows.get(account.id)?.properties.enabled).toBe(false);
	});
});

/** In-memory Tier-2 stand-in (the production CredentialStore seals to disk). */
function makeFakeCredentials() {
	const entries = new Map<string, Uint8Array>();
	return {
		entries,
		store: {
			set: async (target: { app: string; key: string }, value: Uint8Array) => {
				entries.set(`${target.app}/${target.key}`, value);
			},
			get: async (target: { app: string; key: string }) =>
				entries.get(`${target.app}/${target.key}`) ?? null,
			delete: async (target: { app: string; key: string }) =>
				entries.delete(`${target.app}/${target.key}`),
		} as unknown as NonNullable<ReturnType<NonNullable<MailServiceDeps["getCredentials"]>>>,
	};
}

const IMAP_CONNECT_ARG = {
	address: "razor@example.com",
	username: "razor",
	secret: "app-password-1",
	incoming: { host: "imap.example.com", port: 993, tls: true },
	outgoing: { host: "smtp.example.com", port: 465, tls: true },
	syncWindow: SyncWindow.Days90,
};

describe("mail.connectImap", () => {
	it("creates the account row and seals the secret in Tier 2 — never on an entity", async () => {
		const { deps, store } = makeDeps();
		const creds = makeFakeCredentials();
		deps.getCredentials = () => creds.store;
		const handler = makeMailServiceHandler(deps);
		const result = (await handler(envelope("connectImap", IMAP_CONNECT_ARG))) as {
			accountId: string;
			address: string;
		};
		expect(result.address).toBe("razor@example.com");
		const account = store.rows.get(result.accountId);
		expect(account?.properties.protocol).toBe(MailProtocol.Imap);
		expect(account?.properties.authKind).toBe(AuthKind.AppPassword);
		expect(account?.properties.incoming).toEqual(IMAP_CONNECT_ARG.incoming);
		expect(account?.properties.syncWindow).toBe(SyncWindow.Days90);
		for (const row of store.rows.values()) {
			expect(JSON.stringify(row.properties)).not.toContain("app-password-1");
		}
		const sealed = creds.entries.get(`${MAILBOX_APP_ID}/mail-account:${result.accountId}`);
		expect(sealed).toBeDefined();
		expect(new TextDecoder().decode(sealed)).toContain("app-password-1");
	});

	it("reconnect-in-place: an accountRef re-seals the secret and updates the SAME entity (Mailbox-13)", async () => {
		const { deps, store } = makeDeps();
		const creds = makeFakeCredentials();
		deps.getCredentials = () => creds.store;
		const handler = makeMailServiceHandler(deps);
		const first = (await handler(envelope("connectImap", IMAP_CONNECT_ARG))) as {
			accountId: string;
		};
		const rowsBefore = [...store.rows.values()].filter(
			(r) => r.type === MAIL_ACCOUNT_TYPE_URL,
		).length;

		const result = (await handler(
			envelope("connectImap", {
				...IMAP_CONNECT_ARG,
				accountRef: first.accountId,
				secret: "rotated-password-2",
				incoming: { host: "imap2.example.com", port: 993, tls: true },
			}),
		)) as { accountId: string };
		expect(result.accountId).toBe(first.accountId);
		const rowsAfter = [...store.rows.values()].filter((r) => r.type === MAIL_ACCOUNT_TYPE_URL);
		expect(rowsAfter.length).toBe(rowsBefore); // updated, not duplicated
		const row = store.rows.get(first.accountId);
		expect((row?.properties.incoming as { host: string }).host).toBe("imap2.example.com");
		expect(row?.properties.enabled).toBe(true);
		const sealed = creds.entries.get(`${MAILBOX_APP_ID}/mail-account:${first.accountId}`);
		expect(new TextDecoder().decode(sealed)).toContain("rotated-password-2");
	});

	it("reconnect-in-place rejects an unknown or non-IMAP account", async () => {
		const { deps, store } = makeDeps();
		const creds = makeFakeCredentials();
		deps.getCredentials = () => creds.store;
		const gmail = store.insert(MAIL_ACCOUNT_TYPE_URL, {
			address: "me@example.com",
			protocol: MailProtocol.GmailApi,
			enabled: true,
		});
		const handler = makeMailServiceHandler(deps);
		await expect(
			handler(envelope("connectImap", { ...IMAP_CONNECT_ARG, accountRef: "ent-missing" })),
		).rejects.toMatchObject({ name: "Invalid" });
		await expect(
			handler(envelope("connectImap", { ...IMAP_CONNECT_ARG, accountRef: gmail.id })),
		).rejects.toMatchObject({ message: expect.stringContaining("not an IMAP account") });
	});

	it("disables the account when sealing the secret fails", async () => {
		const { deps, store } = makeDeps();
		const creds = makeFakeCredentials();
		creds.store.set = () => Promise.reject(new Error("keystore locked"));
		deps.getCredentials = () => creds.store;
		const handler = makeMailServiceHandler(deps);
		await expect(handler(envelope("connectImap", IMAP_CONNECT_ARG))).rejects.toThrow(
			"keystore locked",
		);
		const account = [...store.rows.values()].find((r) => r.type === MAIL_ACCOUNT_TYPE_URL);
		expect(account?.properties.enabled).toBe(false);
	});

	it("is Unavailable without a credential store and Invalid on a bad host config", async () => {
		const { deps } = makeDeps();
		const handler = makeMailServiceHandler(deps);
		await expect(handler(envelope("connectImap", IMAP_CONNECT_ARG))).rejects.toMatchObject({
			name: "Unavailable",
		});
		deps.getCredentials = () => makeFakeCredentials().store;
		await expect(
			handler(
				envelope("connectImap", {
					...IMAP_CONNECT_ARG,
					incoming: { host: "imap.example.com", port: 70_000, tls: true },
				}),
			),
		).rejects.toMatchObject({ name: "Invalid" });
	});
});

describe("mail.syncNow (imap)", () => {
	it("injects the Tier-2 app-password + host config into the worker connect", async () => {
		const { deps, store, connect } = makeDeps();
		const creds = makeFakeCredentials();
		deps.getCredentials = () => creds.store;
		const handler = makeMailServiceHandler(deps);
		const { accountId } = (await handler(envelope("connectImap", IMAP_CONNECT_ARG))) as {
			accountId: string;
		};
		const result = (await handler(envelope("syncNow", { accountRef: accountId }))) as {
			created: number;
		};
		expect(result.created).toBe(1);
		expect(connect).toHaveBeenCalledWith({
			accountId,
			protocol: MailProtocol.Imap,
			incoming: IMAP_CONNECT_ARG.incoming,
			outgoing: IMAP_CONNECT_ARG.outgoing,
			credentials: { secret: "app-password-1", username: "razor" },
		});
		void store;
	});

	it("is Denied when the Tier-2 entry is gone (reconnect required)", async () => {
		const { deps, store } = makeDeps();
		const creds = makeFakeCredentials();
		deps.getCredentials = () => creds.store;
		const account = store.insert(MAIL_ACCOUNT_TYPE_URL, {
			address: "razor@example.com",
			protocol: MailProtocol.Imap,
			incoming: IMAP_CONNECT_ARG.incoming,
			outgoing: IMAP_CONNECT_ARG.outgoing,
			syncWindow: SyncWindow.Days30,
			enabled: true,
		});
		const handler = makeMailServiceHandler(deps);
		await expect(handler(envelope("syncNow", { accountRef: account.id }))).rejects.toMatchObject({
			name: "Denied",
		});
	});
});

describe("mail send (intent path)", () => {
	function seedGmail(store: ReturnType<typeof makeFakeStore>) {
		store.insert(CONNECTOR_TYPE_URL, {
			connectorAppId: MAILBOX_APP_ID,
			oauth: { clientId: "cid" },
		});
		return store.insert(MAIL_ACCOUNT_TYPE_URL, {
			address: "me@example.com",
			displayName: "Razor",
			protocol: MailProtocol.GmailApi,
			authKind: AuthKind.OAuth2,
			syncWindow: SyncWindow.Days30,
			enabled: true,
			connectorAccountRef: "conn-acc-1",
		});
	}

	const sendArg = (accountRef: string, submissionId = "sub-1") => ({
		accountRef,
		to: ["dana@example.com"],
		subject: "hello",
		bodyText: "hi there",
		submissionId,
	});

	it("submits through the driver, projects the Sent email, and closes the driver", async () => {
		const { deps, store, driver, closeSpy } = makeDeps();
		const account = seedGmail(store);
		const submit = vi
			.fn()
			.mockResolvedValue({ messageId: "<sub-1@brainstorm.local>", receivedAt: 1_700_000_000_500 });
		driver.submit = submit;
		const api = createMailService(deps);
		const result = await api.send(sendArg(account.id));
		expect(result.deduped).toBe(false);
		const submitted = submit.mock.calls[0]?.[0] as { from: string; submissionId: string };
		expect(submitted.from).toBe("Razor <me@example.com>");
		expect(submitted.submissionId).toBe("sub-1");
		const email = store.rows.get(result.emailId);
		expect(email?.properties.submissionId).toBe("sub-1");
		expect(email?.properties.messageId).toBe("<sub-1@brainstorm.local>");
		expect(closeSpy).toHaveBeenCalled();
	});

	it("is idempotent on submissionId — a duplicate returns the existing email without submitting", async () => {
		const { deps, store, driver } = makeDeps();
		const account = seedGmail(store);
		const submit = vi
			.fn()
			.mockResolvedValue({ messageId: "<sub-1@brainstorm.local>", receivedAt: 1_700_000_000_500 });
		driver.submit = submit;
		const api = createMailService(deps);
		const first = await api.send(sendArg(account.id));
		const second = await api.send(sendArg(account.id));
		expect(second.deduped).toBe(true);
		expect(second.emailId).toBe(first.emailId);
		expect(submit).toHaveBeenCalledTimes(1);
	});

	it("rejects a malformed payload and a disabled account", async () => {
		const { deps, store } = makeDeps();
		const account = seedGmail(store);
		const api = createMailService(deps);
		await expect(api.send({ accountRef: account.id })).rejects.toMatchObject({ name: "Invalid" });
		await expect(
			api.send({ accountRef: account.id, to: [], submissionId: "s" }),
		).rejects.toMatchObject({ name: "Invalid" });
		store.rows.get(account.id)?.properties &&
			Object.assign(store.rows.get(account.id)?.properties ?? {}, { enabled: false });
		await expect(api.send(sendArg(account.id))).rejects.toMatchObject({ name: "Invalid" });
	});
});

describe("mail.disconnect (imap)", () => {
	it("deletes the Tier-2 credential and disables the account", async () => {
		const { deps, store } = makeDeps();
		const creds = makeFakeCredentials();
		deps.getCredentials = () => creds.store;
		const handler = makeMailServiceHandler(deps);
		const { accountId } = (await handler(envelope("connectImap", IMAP_CONNECT_ARG))) as {
			accountId: string;
		};
		expect(creds.entries.size).toBe(1);
		await handler(envelope("disconnect", { accountRef: accountId }));
		expect(creds.entries.size).toBe(0);
		expect(store.rows.get(accountId)?.properties.enabled).toBe(false);
	});
});

describe("mail.fetchAttachment", () => {
	const PART = "m1:att-1";

	function makeAssetStore() {
		const written: { bytes: Uint8Array; mime: string }[] = [];
		const bound: string[] = [];
		const store = {
			writeAsset: vi.fn(async (input: { bytes: Uint8Array; mime: string }) => {
				written.push({ bytes: input.bytes, mime: input.mime });
				return { assetId: `asset-${written.length}`, contentHash: "hash" };
			}),
			markBound: vi.fn((assetId: string) => {
				bound.push(assetId);
				return true;
			}),
		};
		return { store, written, bound };
	}

	function seed(store: ReturnType<typeof makeFakeStore>, parts: unknown) {
		store.insert(CONNECTOR_TYPE_URL, {
			connectorAppId: MAILBOX_APP_ID,
			oauth: { clientId: "cid" },
		});
		const account = store.insert(MAIL_ACCOUNT_TYPE_URL, {
			address: "me@example.com",
			protocol: MailProtocol.GmailApi,
			authKind: AuthKind.OAuth2,
			syncWindow: SyncWindow.Days30,
			enabled: true,
			connectorAccountRef: "conn-acc-1",
		});
		const folder = store.insert(MAIL_FOLDER_TYPE_URL, {
			accountRef: account.id,
			path: "INBOX",
			role: "inbox",
			unreadCount: 0,
		});
		const email = store.insert(EMAIL_TYPE, {
			accountRef: account.id,
			folderRefs: [folder.id],
			messageId: "<msg-1@mail.gmail.com>",
			from: [],
			to: [],
			receivedAt: 1,
			flags: [],
			attachmentParts: parts,
		});
		return { account, folder, email };
	}

	function setup(parts: unknown = [{ partRef: PART, filename: "report.pdf" }]) {
		const store = makeFakeStore();
		const { deps, driver } = makeDeps(store);
		const assets = makeAssetStore();
		deps.getAssetStore = async () =>
			assets.store as unknown as NonNullable<
				Awaited<ReturnType<NonNullable<MailServiceDeps["getAssetStore"]>>>
			>;
		const fetchAttachment = vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3, 4]) }));
		driver.fetchAttachment = fetchAttachment;
		const ids = seed(store, parts);
		return { store, deps, assets, driver, fetchAttachment, ...ids };
	}

	it("fetches the part, binds an asset, and links a File entity onto the email", async () => {
		const { store, deps, assets, fetchAttachment, email } = setup();
		const handler = makeMailServiceHandler(deps);
		const result = (await handler(
			envelope("fetchAttachment", { emailRef: email.id, partRef: PART }),
		)) as { fileRef: string; mime: string; size: number; alreadyFetched: boolean };

		// Folder + account came from the stored email, not the caller.
		expect(fetchAttachment).toHaveBeenCalledWith({ folderPath: "INBOX", partRef: PART });
		expect(result.size).toBe(4);
		expect(result.mime).toBe("application/pdf");
		expect(result.alreadyFetched).toBe(false);
		expect(assets.bound).toEqual(["asset-1"]);

		const file = store.rows.get(result.fileRef);
		// F-421: without assetMime the Files tile never renders a thumbnail.
		expect(file?.properties.assetMime).toBe("application/pdf");
		expect(file?.properties.assetId).toBe("asset-1");
		expect(store.rows.get(email.id)?.properties.attachments).toEqual([result.fileRef]);
	});

	it("refuses a part the email does not declare, without reaching the driver", async () => {
		const { deps, fetchAttachment, email } = setup();
		const handler = makeMailServiceHandler(deps);
		await expect(
			handler(envelope("fetchAttachment", { emailRef: email.id, partRef: "m9:evil" })),
		).rejects.toMatchObject({ message: expect.stringContaining("no such attachment") });
		expect(fetchAttachment).not.toHaveBeenCalled();
	});

	it("refuses a ref that is not an email", async () => {
		const { deps, fetchAttachment, folder } = setup();
		const handler = makeMailServiceHandler(deps);
		await expect(
			handler(envelope("fetchAttachment", { emailRef: folder.id, partRef: PART })),
		).rejects.toMatchObject({ message: expect.stringContaining("no such email") });
		expect(fetchAttachment).not.toHaveBeenCalled();
	});

	it("replays an already-fetched part without re-downloading or minting a second file", async () => {
		const { store, deps, assets, fetchAttachment, email } = setup();
		const handler = makeMailServiceHandler(deps);
		const first = (await handler(
			envelope("fetchAttachment", { emailRef: email.id, partRef: PART }),
		)) as { fileRef: string };
		const second = (await handler(
			envelope("fetchAttachment", { emailRef: email.id, partRef: PART }),
		)) as { fileRef: string; alreadyFetched: boolean };

		expect(second.fileRef).toBe(first.fileRef);
		expect(second.alreadyFetched).toBe(true);
		expect(fetchAttachment).toHaveBeenCalledTimes(1);
		expect(assets.written).toHaveLength(1);
		expect(store.rows.get(email.id)?.properties.attachments).toEqual([first.fileRef]);
	});

	it("reports Unavailable when the account's driver cannot address parts", async () => {
		const { deps, email } = setup();
		// A driver from before the seam existed: no `fetchAttachment` at all.
		deps.transport = { ...deps.transport, driverFor: () => makeFakeDriver() };
		const handler = makeMailServiceHandler(deps);
		await expect(
			handler(envelope("fetchAttachment", { emailRef: email.id, partRef: PART })),
		).rejects.toMatchObject({ message: expect.stringContaining("unsupported") });
	});

	it("denies the call when the app lacks mail.manage, before any fetch", async () => {
		const { deps, fetchAttachment, email } = setup();
		const has = vi.fn().mockReturnValue(false);
		deps.getLedger = () =>
			Promise.resolve({ has } as unknown as Awaited<
				ReturnType<NonNullable<MailServiceDeps["getLedger"]>>
			>);
		const handler = makeMailServiceHandler(deps);
		await expect(
			handler(envelope("fetchAttachment", { emailRef: email.id, partRef: PART })),
		).rejects.toMatchObject({ message: expect.stringContaining(`lacks ${MAIL_MANAGE_CAP}`) });
		expect(has).toHaveBeenCalledWith(MAILBOX_APP_ID, MAIL_MANAGE_CAP);
		expect(fetchAttachment).not.toHaveBeenCalled();
	});

	it("closes the driver even when the fetch fails", async () => {
		const { deps, driver, email } = setup();
		const closeSpy = vi.spyOn(driver, "close");
		driver.fetchAttachment = vi.fn().mockRejectedValue(new Error("wire blew up"));
		const handler = makeMailServiceHandler(deps);
		await expect(
			handler(envelope("fetchAttachment", { emailRef: email.id, partRef: PART })),
		).rejects.toBeDefined();
		expect(closeSpy).toHaveBeenCalled();
	});

	it("ignores malformed entries in the stored parts list", async () => {
		const { deps, fetchAttachment, email } = setup([
			null,
			{ filename: "no-ref.pdf" },
			{ partRef: PART, filename: "report.pdf" },
		]);
		const handler = makeMailServiceHandler(deps);
		await handler(envelope("fetchAttachment", { emailRef: email.id, partRef: PART }));
		expect(fetchAttachment).toHaveBeenCalledTimes(1);
	});
});
