/**
 * Connector-7 — Mailbox as the reference connector: the in-process
 * end-to-end proof of the connector contract (doc 56) on the
 * socket-exception path (doc 53 / OQ-MB-2, the one sanctioned exception to
 * "HTTP only": the MailTransport worker owns the network I/O; the sandboxed
 * app never touches a socket, a token, or the driver RPC).
 *
 * The chain under test is the PRODUCTION shape end to end: the real
 * `Broker` (ipc/broker.ts) with the real `RendererIdentityRegistry` and a
 * real `CapabilityLedger` (SQLite ledger.db) granted EXACTLY what the
 * installer grants from `apps/mailbox/manifest.json`; the real connector
 * wiring (`buildConnectorsServiceDeps` → `OAuthBroker` over a real Tier-2
 * `CredentialStore`); the real `mail` service; the real MailTransport
 * worker envelope handler (`handleMailboxEnvelope`) behind the real
 * `createWorkerMailTransport` proxy; and the real entities service over
 * entities.db. Only the process edges are faked: provider HTTP (canned
 * token/profile responses), the OAuth redirect, and the mail server
 * (`FakeMailDriver` behind the worker's factory seam).
 *
 * Contract clauses pinned here:
 *   1. connect → OAuth broker → Tier-2 custody: the token/refresh-token/
 *      client-secret exist ONLY sealed in the credential store — never on
 *      any entity row, never in any reply toward the app.
 *   2. Capability grants: every mail method re-checks `mail.manage`
 *      server-side; the sync's entity writes ride the ledger under the
 *      mailbox app identity and fail closed when a write grant is revoked.
 *   3. Socket exception: the worker performs the I/O with the
 *      shell-injected credential and is `_shell`-gated — a renderer cannot
 *      spoof `_shell` (identity registry) and cannot drive the
 *      broker-registered `mailbox` worker RPC; the driver (and secret) are
 *      dropped after every engine run.
 *   4. Sync substrate → entity write path: real MailFolder/Email rows,
 *      idempotent on `messageId` across re-syncs; send is idempotent on
 *      `submissionId`.
 *   5. Disconnect revokes cleanly: Tier-2 token deleted, ConnectorAccount
 *      → revoked, MailAccount disabled, further syncs refused.
 */

import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyDefaultAppGrants } from "@brainstorm-os/capabilities/default-grants";
import { CapabilityLedger, GrantedVia } from "@brainstorm-os/capabilities/ledger";
import {
	AuthState,
	CONNECTOR_ACCOUNT_TYPE_URL,
	CONNECTOR_TYPE_URL,
	EMAIL_TYPE_URL,
	FILE_ENTITY_TYPE,
	FolderRole,
	MAIL_ACCOUNT_TYPE_URL,
	MAIL_FOLDER_TYPE_URL,
	MailProtocol,
} from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Broker, type ServiceRegistry } from "../../ipc/broker";
import type { Envelope, EnvelopeReply } from "../../ipc/envelope";
import {
	__resetMailboxWorker,
	__setMailDriverFactory,
	handleMailboxEnvelope,
} from "../../workers/mailbox";
import type { DriverFactoryInput } from "../../workers/mailbox";
import { __ydocCacheResetForTest, handleYDocEnvelope } from "../../workers/ydoc";
import type { AssetStore } from "../assets/asset-store";
import type { ConnectorEgress, ConnectorEgressResponse } from "../connectors/egress";
import type { RedirectProvider } from "../connectors/oauth-redirect";
import { buildConnectorsServiceDeps } from "../connectors/wiring";
import { generateSymmetricKey } from "../credentials/crypto";
import { CredentialStore } from "../credentials/store";
import { makeEntitiesServiceHandler } from "../entities/entities-service";
import { EntityDekStore } from "../entities/entity-dek-store";
import { RendererIdentityRegistry } from "../ipc/renderer-identity";
import { FakeMailDriver, type FakeServerState } from "../mailbox/fake-mail-driver";
import type { MailDriver } from "../mailbox/mail-driver";
import { GMAIL_TOKEN_URL, MAILBOX_APP_ID, createMailService } from "../mailbox/mailbox-service";
import { createWorkerMailTransport } from "../mailbox/worker-mail-transport";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository, EntityDeksRepository } from "../storage/entities-repo";

const T0 = Date.UTC(2026, 6, 1, 9, 0, 0);
const DAY = 86_400_000;

const MAILBOX_WC = 11;
const SPY_APP = "io.brainstorm.spy";
const SPY_WC = 77;

const ACCESS_TOKEN = "ACCESS-TOKEN-SECRET-A1";
const REFRESH_TOKEN = "REFRESH-TOKEN-SECRET-R1";
const CLIENT_SECRET = "GOOG-CLIENT-SECRET-XYZZY";
const SECRETS = [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET] as const;

const MANIFEST_PATH = fileURLToPath(
	new URL("../../../../../apps/mailbox/manifest.json", import.meta.url),
);

function jsonResponse(value: unknown, finalUrl: string): ConnectorEgressResponse {
	return {
		status: 200,
		headers: { "content-type": "application/json" },
		body: new TextEncoder().encode(JSON.stringify(value)),
		finalUrl,
	};
}

const fakeRedirect: RedirectProvider = {
	start: () =>
		Promise.resolve({
			redirectUri: "http://127.0.0.1:50000/cb",
			waitForCode: () => Promise.resolve("auth-code"),
			close: () => {},
		}),
};

function serverState(): FakeServerState {
	return {
		folders: [
			{ path: "INBOX", role: FolderRole.Inbox, unreadCount: 2 },
			{ path: "Sent", role: FolderRole.Sent, unreadCount: 0 },
		],
		messages: {
			INBOX: [
				{
					messageId: "<m1@example.com>",
					from: "Dana Lee <dana@example.com>",
					to: "me@example.com",
					subject: "hello",
					receivedAt: T0 - DAY,
					flags: [],
					folderPath: "INBOX",
				},
				{
					messageId: "<m2@example.com>",
					from: "Sam Roe <sam@example.com>",
					to: "me@example.com",
					subject: "report attached",
					receivedAt: T0 - 2 * DAY,
					flags: [],
					folderPath: "INBOX",
					attachmentParts: [
						{ partRef: "p1", filename: "report.pdf", mimeType: "application/pdf", sizeBytes: 3 },
					],
				},
			],
			Sent: [],
		},
	};
}

/** The FakeMailDriver plus a byte-serving `fetchAttachment` (the fake has
 *  none), delegating everything else — so the Mailbox-6 leg rides the same
 *  worker RPC as the sync legs. */
function withAttachmentBytes(driver: FakeMailDriver): MailDriver {
	return {
		protocol: driver.protocol,
		listFolders: () => driver.listFolders(),
		fetch: (spec) => driver.fetch(spec),
		submit: (message) => driver.submit(message),
		close: () => driver.close(),
		fetchAttachment: () =>
			Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), mimeType: "application/pdf" }),
	};
}

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "bs-mailbox-e2e-"));
	const stores = new DataStores(vaultDir);
	const repo = new EntitiesRepository(await stores.open("entities"));
	const dekStore = new EntityDekStore(
		new EntityDeksRepository(await stores.open("entities")),
		generateSymmetricKey(),
	);

	// The REAL ledger over ledger.db, granted exactly what the installer
	// grants at install time: default-minimum + the manifest's capability
	// list. If the mail path needs a write the manifest doesn't declare,
	// this harness fails exactly as production does.
	const ledger = new CapabilityLedger(await stores.open("ledger"));
	const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as {
		id: string;
		capabilities: string[];
	};
	const grantInstallSet = (appId: string, caps: readonly string[]) => {
		applyDefaultAppGrants(ledger, appId);
		for (const cap of caps) {
			const i = cap.indexOf(":");
			ledger.grant({
				appId,
				capability: i < 0 ? cap : cap.slice(0, i),
				scope: i < 0 ? null : cap.slice(i + 1),
				grantedVia: GrantedVia.Install,
			});
		}
	};
	grantInstallSet(manifest.id, manifest.capabilities);
	grantInstallSet(SPY_APP, []);

	let idSeq = 0;
	const entitiesHandler = makeEntitiesServiceHandler({
		getRepo: async () => repo,
		getLedger: async () => ledger,
		getDekStore: async () => dekStore,
		newId: () => {
			idSeq += 1;
			return `ent_${idSeq}`;
		},
		getVaultPath: () => vaultDir,
		ydoc: async (method, a) => {
			const reply = await handleYDocEnvelope({
				v: 1,
				msg: "y",
				app: "io.brainstorm.shell",
				service: "ydoc",
				method,
				args: [a],
				caps: [],
			});
			if (!reply.ok) throw new Error(`ydoc.${method} failed: ${reply.error.message}`);
			return reply.value;
		},
	});

	// The real broker + the real renderer-identity registry, wired exactly
	// like BrokerContext: identity fail-closed, declared caps against the
	// live ledger.
	const identities = new RendererIdentityRegistry();
	identities.register(MAILBOX_WC, MAILBOX_APP_ID);
	identities.register(SPY_WC, SPY_APP);
	const services: ServiceRegistry = new Map();
	const denials: string[] = [];
	const broker = new Broker({
		services,
		verifyAppIdentity: (claimedApp, source) => identities.verify(claimedApp, source),
		checkCapability: (app, _service, _method, declaredCaps) =>
			declaredCaps.every((cap) => ledger.has(app, cap)),
		onDenied: (event) => denials.push(`${event.kind} ${event.service}.${event.method}`),
	});
	broker.registerService("entities", entitiesHandler);

	let msgSeq = 0;
	// Main-originated, connector-attributed entities calls — the production
	// `connectorsCallEntities` shape (direct handler, ledger enforced inside
	// the entities service under the connector's app identity).
	const callEntities = (app: string, method: string, arg: unknown): Promise<unknown> => {
		const handler = broker.getServiceHandler("entities");
		if (!handler) throw new Error("entities service unavailable");
		msgSeq += 1;
		return Promise.resolve(
			handler({
				v: 1,
				msg: `conn_${msgSeq}`,
				app,
				service: "entities",
				method,
				args: [arg],
				caps: [],
			}),
		);
	};

	// REAL Tier-2 custody: sealed to disk under a real master key.
	const credentials = new CredentialStore(vaultDir, generateSymmetricKey());

	const egressCalls: string[] = [];
	const egress: ConnectorEgress = async (req) => {
		egressCalls.push(`${req.method ?? "GET"} ${req.url}`);
		if (req.url === GMAIL_TOKEN_URL) {
			return jsonResponse(
				{
					access_token: ACCESS_TOKEN,
					refresh_token: REFRESH_TOKEN,
					expires_in: 3600,
					scope: "https://www.googleapis.com/auth/gmail.readonly",
				},
				req.url,
			);
		}
		if (req.url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/profile")) {
			return jsonResponse({ emailAddress: "dana@example.com" }, req.url);
		}
		throw new Error(`unexpected egress ${req.url}`);
	};

	// The production connector wiring — real OAuthBroker over the real
	// credential store, ConnectorAccount writes through the capability-
	// checked entities service under the mailbox identity.
	const connectorsDeps = buildConnectorsServiceDeps({
		egress,
		getRepo: async () => repo,
		getCredentials: () => credentials,
		getLedger: async () => ledger,
		callEntities,
		openExternal: async () => {},
		notify: () => {},
	});
	connectorsDeps.broker.registerTokenEndpoint(GMAIL_TOKEN_URL);

	// The REAL worker envelope handler as the transport — the socket
	// exception in-process. The factory seam captures what the shell
	// injects (the credential the worker uses for its I/O).
	const workerConnects: DriverFactoryInput[] = [];
	__setMailDriverFactory((input) => {
		workerConnects.push(input);
		return withAttachmentBytes(new FakeMailDriver(serverState()));
	});
	const transport = createWorkerMailTransport({
		send: (envelope) => handleMailboxEnvelope(envelope),
	});

	const storedAssets: { assetId: string; bytes: Uint8Array; mime: string }[] = [];
	const assetStore = {
		writeAsset: (input: { bytes: Uint8Array; mime: string }) => {
			const assetId = `asset-${storedAssets.length + 1}`;
			storedAssets.push({ assetId, bytes: input.bytes, mime: input.mime });
			return Promise.resolve({ assetId });
		},
		markBound: () => {},
	} as unknown as AssetStore;

	const mailApi = createMailService({
		broker: connectorsDeps.broker,
		redirectProvider: fakeRedirect,
		egress,
		getRepo: async () => repo,
		callEntities,
		transport,
		getCredentials: () => credentials,
		getLedger: async () => ledger,
		getAssetStore: async () => assetStore,
		now: () => T0,
	});
	broker.registerService("mail", mailApi.handler);
	// Production registers the MailTransport worker bridge on the broker
	// (`makeBridgeHandler(mailbox)`); the worker's `_shell` gate is what
	// keeps renderers out. Mirror that registration shape.
	broker.registerService("mailbox", async (envelope: Envelope) => {
		const reply = await handleMailboxEnvelope(envelope);
		if (reply.ok) return reply.value;
		const err = new Error(reply.error.message);
		err.name = reply.error.kind;
		throw err;
	});

	const dispatch = (
		app: string,
		service: string,
		method: string,
		arg: unknown,
		source: unknown = { webContentsId: MAILBOX_WC },
	): Promise<EnvelopeReply> => {
		msgSeq += 1;
		return broker.dispatch(
			{ v: 1, msg: `it_${msgSeq}`, app, service, method, args: [arg], caps: [] },
			source,
		);
	};

	const rowsOfType = async (type: string) =>
		(await callEntities(MAILBOX_APP_ID, "query", { query: { type } })) as Array<{
			id: string;
			properties: Record<string, unknown>;
		}>;

	const connectAccount = async (): Promise<{ accountId: string; connectorAccountRef: string }> => {
		const reply = await dispatch(MAILBOX_APP_ID, "mail", "connectGmail", {
			clientId: "client-id-1",
			clientSecret: CLIENT_SECRET,
			label: "Personal Gmail",
		});
		if (!reply.ok) throw new Error(`connectGmail failed: ${reply.error.message}`);
		const { accountId } = reply.value as { accountId: string };
		const account = (await rowsOfType(MAIL_ACCOUNT_TYPE_URL)).find((r) => r.id === accountId);
		return {
			accountId,
			connectorAccountRef: account?.properties.connectorAccountRef as string,
		};
	};

	return {
		vaultDir,
		stores,
		repo,
		ledger,
		manifest,
		credentials,
		broker,
		dispatch,
		rowsOfType,
		connectAccount,
		workerConnects,
		storedAssets,
		egressCalls,
		denials,
		mailApi,
	};
}

describe("Mailbox pipeline — the Connector-7 contract end-to-end (socket-exception path)", () => {
	let env: Awaited<ReturnType<typeof setup>>;

	beforeEach(async () => {
		__ydocCacheResetForTest();
		await __resetMailboxWorker();
		env = await setup();
	});

	afterEach(async () => {
		await __resetMailboxWorker();
		__ydocCacheResetForTest();
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	it("manifest: the connector declares its caps and NO network/socket capability", () => {
		expect(env.manifest.id).toBe(MAILBOX_APP_ID);
		expect(env.manifest.capabilities).toContain("mail.manage");
		// The socket exception lives shell-side: the sandboxed app itself
		// holds no network capability of any kind.
		expect(env.manifest.capabilities.filter((c) => /network|socket|egress/i.test(c))).toEqual([]);
	});

	it("connect: OAuth via the shell broker; tokens + client secret sealed in Tier 2, never on an entity, never toward the app", async () => {
		const reply = await env.dispatch(MAILBOX_APP_ID, "mail", "connectGmail", {
			clientId: "client-id-1",
			clientSecret: CLIENT_SECRET,
			label: "Personal Gmail",
		});
		expect(reply.ok).toBe(true);
		if (!reply.ok) return;
		const { accountId, address } = reply.value as { accountId: string; address: string };
		expect(address).toBe("dana@example.com");

		// The app-visible reply carries no secret material.
		expect(JSON.stringify(reply)).not.toMatch(new RegExp(SECRETS.join("|")));

		// Connector/v1 frozen egress origins + ConnectorAccount/v1 bookkeeping
		// (no secret), MailAccount/v1 linked by connectorAccountRef — all in
		// the real entities.db under the manifest's own write grants.
		const connectors = await env.rowsOfType(CONNECTOR_TYPE_URL);
		expect(connectors).toHaveLength(1);
		expect(connectors[0]?.properties.egressOrigins).toEqual([
			"https://gmail.googleapis.com",
			"https://accounts.google.com",
			"https://oauth2.googleapis.com",
		]);
		const connAccounts = await env.rowsOfType(CONNECTOR_ACCOUNT_TYPE_URL);
		expect(connAccounts).toHaveLength(1);
		expect(connAccounts[0]?.properties.authState).toBe(AuthState.Active);
		const mailAccounts = await env.rowsOfType(MAIL_ACCOUNT_TYPE_URL);
		expect(mailAccounts[0]?.id).toBe(accountId);
		expect(mailAccounts[0]?.properties.protocol).toBe(MailProtocol.GmailApi);
		expect(mailAccounts[0]?.properties.connectorAccountRef).toBe(connAccounts[0]?.id);

		// No entity row of ANY type carries token material.
		const everything = [...connectors, ...connAccounts, ...mailAccounts].map((r) =>
			JSON.stringify(r.properties),
		);
		for (const secret of SECRETS) {
			expect(everything.some((json) => json.includes(secret))).toBe(false);
		}

		// The token IS retrievable shell-side from Tier 2 (sealed at rest:
		// the on-disk credentials file contains only ciphertext).
		const sealed = await env.credentials.get({
			app: MAILBOX_APP_ID,
			key: `oauth:${connAccounts[0]?.id}`,
		});
		expect(sealed).not.toBeNull();
		const stored = JSON.parse(new TextDecoder().decode(sealed as Uint8Array)) as Record<
			string,
			string
		>;
		expect(stored.accessToken).toBe(ACCESS_TOKEN);
		expect(stored.refreshToken).toBe(REFRESH_TOKEN);
		expect(stored.clientSecret).toBe(CLIENT_SECRET);
		const rawFile = await readFile(join(env.vaultDir, "shell", "credentials.json"), "utf8");
		for (const secret of SECRETS) expect(rawFile).not.toContain(secret);
	});

	it("capability grants: mail.manage is re-checked server-side per envelope, fail-closed", async () => {
		// An app without the grant is Denied by the service even though the
		// broker-level declared-caps check passed (empty caps declared).
		const denied = await env.dispatch(
			SPY_APP,
			"mail",
			"syncNow",
			{ accountRef: "whatever" },
			{ webContentsId: SPY_WC },
		);
		expect(denied.ok).toBe(false);
		if (!denied.ok) expect(denied.error.kind).toBe("Denied");

		// Declaring a cap you don't hold is refused at the broker itself.
		const brokerDenied = await env.broker.dispatch(
			{
				v: 1,
				msg: "spy-1",
				app: SPY_APP,
				service: "mail",
				method: "syncNow",
				args: [{ accountRef: "whatever" }],
				caps: ["mail.manage"],
			},
			{ webContentsId: SPY_WC },
		);
		expect(brokerDenied.ok).toBe(false);
		if (!brokerDenied.ok) expect(brokerDenied.error.kind).toBe("CapabilityDenied");
		expect(env.denials.some((d) => d.includes("mail.syncNow"))).toBe(true);
	});

	it("socket exception: a renderer cannot spoof _shell and cannot drive the worker RPC", async () => {
		// The identity registry refuses a renderer claiming the shell sentinel.
		const spoof = await env.dispatch(
			"_shell",
			"mailbox",
			"fetch",
			{ accountId: "x", spec: { folderPath: "INBOX", limit: 1 } },
			{ webContentsId: MAILBOX_WC },
		);
		expect(spoof.ok).toBe(false);
		if (!spoof.ok) expect(spoof.error.message).toContain("app identity verification failed");

		// An unregistered source fails identity outright.
		const unknown = await env.dispatch(
			MAILBOX_APP_ID,
			"mail",
			"syncNow",
			{ accountRef: "x" },
			{
				webContentsId: 9999,
			},
		);
		expect(unknown.ok).toBe(false);

		// Even under its own verified identity, the app cannot reach the
		// broker-registered worker RPC: every method is _shell-gated in the
		// worker itself.
		for (const method of ["connect", "listFolders", "fetch", "submit", "close"]) {
			const reply = await env.dispatch(MAILBOX_APP_ID, "mailbox", method, { accountId: "x" });
			expect(reply.ok).toBe(false);
			if (!reply.ok) {
				expect(reply.error.kind).toBe("Invalid");
				expect(reply.error.message).toContain("reserved for the main process");
			}
		}
	});

	it("sync: the worker does the I/O with the shell-injected token; real Email/MailFolder rows; idempotent; driver dropped after the run", async () => {
		const { accountId } = await env.connectAccount();

		const sync = await env.dispatch(MAILBOX_APP_ID, "mail", "syncNow", { accountRef: accountId });
		expect(sync.ok).toBe(true);

		// The worker (not the app) received the OAuth access token as the
		// driver credential — the shell injected it from Tier 2.
		expect(env.workerConnects).toHaveLength(1);
		expect(env.workerConnects[0]?.protocol).toBe(MailProtocol.GmailApi);
		expect(env.workerConnects[0]?.credentials.secret).toBe(ACCESS_TOKEN);

		const folders = await env.rowsOfType(MAIL_FOLDER_TYPE_URL);
		expect(folders.map((f) => f.properties.path).sort()).toEqual(["INBOX", "Sent"]);
		const emails = await env.rowsOfType(EMAIL_TYPE_URL);
		expect(emails).toHaveLength(2);
		expect(emails.every((e) => e.properties.accountRef === accountId)).toBe(true);

		// Re-sync: upsert on messageId — no duplicates.
		const again = await env.dispatch(MAILBOX_APP_ID, "mail", "syncNow", { accountRef: accountId });
		expect(again.ok).toBe(true);
		expect(await env.rowsOfType(EMAIL_TYPE_URL)).toHaveLength(2);

		// The engine closed the worker-side driver on the way out — the
		// injected secret is gone with it.
		const afterClose = await handleMailboxEnvelope({
			v: 1,
			msg: "post",
			app: "_shell",
			service: "mailbox",
			method: "fetch",
			args: [{ accountId, spec: { folderPath: "INBOX", limit: 1 } }],
			caps: [],
		});
		expect(afterClose.ok).toBe(false);
		if (!afterClose.ok) expect(afterClose.error.kind).toBe("Unavailable");
	});

	it("entity writes ride the ledger: revoking the Email write grant fails the sync closed", async () => {
		const { accountId } = await env.connectAccount();
		env.ledger.revoke(MAILBOX_APP_ID, "entities.write", EMAIL_TYPE_URL);
		const sync = await env.dispatch(MAILBOX_APP_ID, "mail", "syncNow", { accountRef: accountId });
		expect(sync.ok).toBe(false);
		if (!sync.ok) expect(sync.error.kind).toBe("Denied");
		expect(await env.rowsOfType(EMAIL_TYPE_URL)).toHaveLength(0);
	});

	it("send is idempotent on submissionId (the intent-path core)", async () => {
		const { accountId } = await env.connectAccount();
		const input = {
			accountRef: accountId,
			to: ["dana@example.com"],
			subject: "re: hello",
			bodyText: "hi back",
			submissionId: "sub-1",
		};
		const first = await env.mailApi.send(input);
		const second = await env.mailApi.send(input);
		expect(second.emailId).toBe(first.emailId);
		const sent = (await env.rowsOfType(EMAIL_TYPE_URL)).filter(
			(e) => e.properties.submissionId === "sub-1",
		);
		expect(sent).toHaveLength(1);
	});

	it("fetchAttachment: bytes ride the worker RPC into a File/v1 under the manifest's declared caps", async () => {
		const { accountId } = await env.connectAccount();
		await env.dispatch(MAILBOX_APP_ID, "mail", "syncNow", { accountRef: accountId });
		const email = (await env.rowsOfType(EMAIL_TYPE_URL)).find(
			(e) => e.properties.subject === "report attached",
		);
		expect(email).toBeDefined();
		if (!email) return;

		const reply = await env.dispatch(MAILBOX_APP_ID, "mail", "fetchAttachment", {
			emailRef: email.id,
			partRef: "p1",
		});
		expect(reply.ok).toBe(true);
		if (!reply.ok) return;
		const view = reply.value as { fileRef: string; name: string };
		expect(view.name).toBe("report.pdf");

		const files = await env.rowsOfType(FILE_ENTITY_TYPE);
		expect(files.map((f) => f.id)).toContain(view.fileRef);
		expect(env.storedAssets).toHaveLength(1);
		const updated = (await env.rowsOfType(EMAIL_TYPE_URL)).find((e) => e.id === email.id);
		expect(updated?.properties.attachments).toEqual([view.fileRef]);
	});

	it("disconnect revokes cleanly: Tier-2 token deleted, account revoked + disabled, sync refused", async () => {
		const { accountId, connectorAccountRef } = await env.connectAccount();

		const reply = await env.dispatch(MAILBOX_APP_ID, "mail", "disconnect", {
			accountRef: accountId,
		});
		expect(reply.ok).toBe(true);

		expect(
			await env.credentials.get({ app: MAILBOX_APP_ID, key: `oauth:${connectorAccountRef}` }),
		).toBeNull();
		const connAccount = (await env.rowsOfType(CONNECTOR_ACCOUNT_TYPE_URL)).find(
			(r) => r.id === connectorAccountRef,
		);
		expect(connAccount?.properties.authState).toBe(AuthState.Revoked);
		const mailAccount = (await env.rowsOfType(MAIL_ACCOUNT_TYPE_URL)).find((r) => r.id === accountId);
		expect(mailAccount?.properties.enabled).toBe(false);

		const sync = await env.dispatch(MAILBOX_APP_ID, "mail", "syncNow", { accountRef: accountId });
		expect(sync.ok).toBe(false);
	});
});
