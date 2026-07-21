/**
 * The app-facing `mail` broker service + the shell-internal mail API
 * (Mailbox-2/-4/-5): account connect (Gmail OAuth via the connector broker,
 * IMAP/SMTP app-password via Tier 2), sync, idempotent send, disconnect.
 * The data path is the MailTransport worker driven by the main-process
 * `MailSyncEngine` (doc 53); Mailbox is the reference connector
 * (Connector-7).
 *
 * Custody: OAuth tokens + the Google installed-app client secret live in
 * Tier 2 via the shared `OAuthBroker`; an IMAP account's app-password lives
 * in Tier 2 keyed by the account's own entity id. The renderer sees only
 * entity refs. Every broker method is re-checked server-side against the
 * `mail.manage` capability (same posture as `connectors-service`).
 *
 * `createMailService` returns the broker handler **and** the shell-internal
 * core (`syncAccount` / `send`) so the IntentsBus `send` verb (Mailbox-4 —
 * the dispatch was already ledger-checked for `intents.dispatch:send`) and
 * the VaultSession-open registration (Mailbox-2) drive the same serialized,
 * idempotent path the app's "Sync now" uses.
 *
 * All IO is injected so the service is unit-tested without Electron; the
 * production binding is in `index.ts` (shares the connector wiring's
 * broker, egress, and entities closures).
 */

import {
	AuthKind,
	CONNECTOR_TYPE_URL,
	EMAIL_TYPE_URL,
	FILE_ENTITY_TYPE,
	MAIL_ACCOUNT_TYPE_URL,
	MAIL_FOLDER_TYPE_URL,
	type MailAttachmentPart,
	type MailFlag,
	type MailHostConfig,
	MailProtocol,
	SyncWindow,
	formatMailAddress,
	isSyncWindow,
} from "@brainstorm-os/sdk-types";
import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import type { AssetStore } from "../assets/asset-store";
import { AssetKind } from "../assets/asset-types";
import type { CapabilityLedger } from "../capabilities/ledger";
import { requireServiceCapability } from "../connectors/connectors-service";
import { type ConnectorEgress, decodeJsonResponse } from "../connectors/egress";
import type { OAuthBroker, ProviderConfig } from "../connectors/oauth-broker";
import type { RedirectProvider } from "../connectors/oauth-redirect";
import type { CredentialStore } from "../credentials/store";
import { servedMimeForName } from "../files/upload-mime";
import type { EntitiesRepository, EntityRow } from "../storage/entities-repo/entities-repo";
import type { DriverCredentials, MailDriver } from "./mail-driver";
import {
	type MailBackfillResult,
	MailSyncEngine,
	type MailSyncResult,
	type SendResult,
} from "./mail-sync-engine";
import { PERSON_TYPE, buildPersonIndex } from "./person-resolver";
import type { WorkerMailTransport } from "./worker-mail-transport";

export const MAIL_MANAGE_CAP = "mail.manage";
export const MAILBOX_APP_ID = "io.brainstorm.mailbox";

const GMAIL_API_ORIGIN = "https://gmail.googleapis.com";
const GOOGLE_ACCOUNTS_ORIGIN = "https://accounts.google.com";
const GOOGLE_TOKEN_ORIGIN = "https://oauth2.googleapis.com";
const GMAIL_AUTHORIZE_URL = `${GOOGLE_ACCOUNTS_ORIGIN}/o/oauth2/v2/auth`;
/** Exported for the SEC1 static token-endpoint registration in `index.ts` —
 *  the OAuth broker refuses token egress to any origin not registered from
 *  static shell code (never from a `Connector/v1` entity). */
export const GMAIL_TOKEN_URL = `${GOOGLE_TOKEN_ORIGIN}/token`;
const GMAIL_SCOPES = [
	"https://www.googleapis.com/auth/gmail.readonly",
	"https://www.googleapis.com/auth/gmail.send",
] as const;
/** Google only issues a refresh token for `access_type=offline`, and only
 *  reliably on a consent re-prompt — without these the account silently
 *  expires after the first hour. */
const GMAIL_EXTRA_AUTH_PARAMS = Object.freeze({ access_type: "offline", prompt: "consent" });

/** Tier-2 key for an IMAP account's app-password (doc 53: the secret keys
 *  off the account entity's own id — never stored on the entity). */
export function mailAccountCredentialKey(accountRef: string): string {
	return `mail-account:${accountRef}`;
}

export type MailServiceDeps = {
	broker: OAuthBroker;
	redirectProvider: RedirectProvider;
	/** Shared connector egress (Net-1) — used only for the post-connect
	 *  profile lookup; the transport worker owns the sync data path. */
	egress: ConnectorEgress;
	getRepo: () => Promise<EntitiesRepository | null>;
	/** Mailbox-attributed entities write (capability-checked under the
	 *  mailbox app identity — same shape as the connector wiring). */
	callEntities: (app: string, method: string, arg: unknown) => Promise<unknown>;
	transport: WorkerMailTransport;
	/** Tier 2 — required for IMAP app-password custody; the Gmail path
	 *  keeps its custody inside the OAuth broker. */
	getCredentials?: () => CredentialStore | null;
	getLedger?: () => Promise<CapabilityLedger | null>;
	/** Asset custody for fetched attachments (Mailbox-6) — bytes land as an
	 *  encrypted asset bound to the `File/v1` entity, never on the email. */
	getAssetStore?: () => Promise<AssetStore | null>;
	now?: () => number;
};

/** The validated payload of a `send` intent / submission (doc 53 §Sending).
 *  `submissionId` is the client-stamped idempotency key — it becomes the
 *  outbound `Message-ID`, and a duplicate returns the existing Sent email
 *  without re-submitting. */
export type MailSendInput = {
	accountRef: string;
	to: string[];
	cc?: string[];
	subject?: string;
	bodyText?: string;
	bodyHtml?: string;
	submissionId: string;
	inReplyTo?: string;
	references?: string[];
};

export type MailServiceApi = {
	/** The broker `mail` service handler (capability-gated per envelope). */
	handler: ServiceHandler;
	/** Shell-internal sync (session-open registration, schedulers). Same
	 *  per-account serialization as the app-facing `syncNow`. */
	syncAccount(accountRef: string): Promise<MailSyncResult>;
	/** Shell-internal idempotent send — the IntentsBus `send` verb lands
	 *  here after the broker checked `intents.dispatch:send`. */
	send(raw: unknown): Promise<SendResult>;
};

function makeError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

function objectArg(envelope: Envelope): Record<string, unknown> {
	const [arg] = envelope.args as [unknown];
	if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
		throw makeError("Invalid", `mail.${envelope.method}: argument must be an object`);
	}
	return arg as Record<string, unknown>;
}

function requireString(value: unknown, field: string, method: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw makeError("Invalid", `mail.${method}: { ${field} } must be a non-empty string`);
	}
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireHostConfig(value: unknown, field: string, method: string): MailHostConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw makeError("Invalid", `mail.${method}: { ${field} } must be { host, port, tls }`);
	}
	const v = value as Record<string, unknown>;
	const host = requireString(v.host, `${field}.host`, method);
	if (typeof v.port !== "number" || !Number.isInteger(v.port) || v.port <= 0 || v.port > 65_535) {
		throw makeError("Invalid", `mail.${method}: { ${field}.port } must be a valid port`);
	}
	if (typeof v.tls !== "boolean") {
		throw makeError("Invalid", `mail.${method}: { ${field}.tls } must be a boolean`);
	}
	return { host, port: v.port, tls: v.tls };
}

function optionalStringList(value: unknown, field: string, method: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.length === 0)) {
		throw makeError("Invalid", `mail.${method}: { ${field} } must be a list of non-empty strings`);
	}
	return value as string[];
}

/** Validate a raw `send` payload (the intent payload arrives untyped). */
export function validateMailSendInput(raw: unknown): MailSendInput {
	const method = "send";
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw makeError("Invalid", `mail.${method}: payload must be an object`);
	}
	const v = raw as Record<string, unknown>;
	const accountRef = requireString(v.accountRef, "accountRef", method);
	const submissionId = requireString(v.submissionId, "submissionId", method);
	const to = optionalStringList(v.to, "to", method);
	if (!to || to.length === 0) {
		throw makeError("Invalid", `mail.${method}: { to } must list at least one recipient`);
	}
	const cc = optionalStringList(v.cc, "cc", method);
	const references = optionalStringList(v.references, "references", method);
	const subject = optionalString(v.subject);
	const bodyText = optionalString(v.bodyText);
	const bodyHtml = optionalString(v.bodyHtml);
	const inReplyTo = optionalString(v.inReplyTo);
	return {
		accountRef,
		to,
		submissionId,
		...(cc ? { cc } : {}),
		...(subject !== undefined ? { subject } : {}),
		...(bodyText !== undefined ? { bodyText } : {}),
		...(bodyHtml !== undefined ? { bodyHtml } : {}),
		...(inReplyTo !== undefined ? { inReplyTo } : {}),
		...(references ? { references } : {}),
	};
}

async function requireRepo(deps: MailServiceDeps): Promise<EntitiesRepository> {
	const repo = await deps.getRepo();
	if (!repo) throw makeError("Unavailable", "mail: no active vault session");
	return repo;
}

function requireCredentialStore(deps: MailServiceDeps, method: string): CredentialStore {
	const store = deps.getCredentials?.() ?? null;
	if (!store) throw makeError("Unavailable", `mail.${method}: credential store unavailable`);
	return store;
}

function gmailProvider(clientId: string): ProviderConfig {
	return {
		authorizeUrl: GMAIL_AUTHORIZE_URL,
		tokenUrl: GMAIL_TOKEN_URL,
		clientId,
		scopes: GMAIL_SCOPES,
		egressOrigins: [GMAIL_API_ORIGIN, GOOGLE_ACCOUNTS_ORIGIN, GOOGLE_TOKEN_ORIGIN],
		extraAuthParams: GMAIL_EXTRA_AUTH_PARAMS,
	};
}

function findGmailConnector(repo: EntitiesRepository): EntityRow | null {
	for (const id of repo.idsByTypes([CONNECTOR_TYPE_URL])) {
		const row = repo.get(id);
		if (row && row.properties.connectorAppId === MAILBOX_APP_ID) return row;
	}
	return null;
}

export function createMailService(deps: MailServiceDeps): MailServiceApi {
	// Engine upserts are find-then-create without a transaction, so two
	// concurrent syncs of one account (or two sends of one submission)
	// could both create the same row — serialize here, where every caller
	// (broker envelope, intent dispatch, session scheduler) funnels through.
	const syncInFlight = new Set<string>();
	const sendInFlight = new Set<string>();

	const syncAccount = async (accountRef: string): Promise<MailSyncResult> => {
		if (syncInFlight.has(accountRef)) {
			throw makeError("Unavailable", "mail.syncNow: a sync is already running for this account");
		}
		syncInFlight.add(accountRef);
		try {
			return await runSync(deps, accountRef);
		} finally {
			syncInFlight.delete(accountRef);
		}
	};

	// Backfill shares the per-account slot with sync — both drive the same
	// find-then-create upsert path.
	const loadOlder = async (accountRef: string): Promise<MailBackfillResult> => {
		if (syncInFlight.has(accountRef)) {
			throw makeError("Unavailable", "mail.loadOlder: a sync is already running for this account");
		}
		syncInFlight.add(accountRef);
		try {
			return await runBackfill(deps, accountRef);
		} finally {
			syncInFlight.delete(accountRef);
		}
	};

	// Two concurrent fetches of one part would both miss the already-fetched
	// check and mint a File entity each, orphaning an asset.
	const attachmentInFlight = new Set<string>();
	const fetchAttachment = async (
		emailRef: string,
		partRef: string,
	): Promise<FetchAttachmentResultView> => {
		const slot = `${emailRef} ${partRef}`;
		if (attachmentInFlight.has(slot)) {
			throw makeError("Unavailable", "mail.fetchAttachment: this attachment is already fetching");
		}
		attachmentInFlight.add(slot);
		try {
			return await runFetchAttachment(deps, emailRef, partRef);
		} finally {
			attachmentInFlight.delete(slot);
		}
	};

	const send = async (raw: unknown): Promise<SendResult> => {
		const input = validateMailSendInput(raw);
		if (sendInFlight.has(input.submissionId)) {
			throw makeError("Unavailable", "mail.send: this submission is already in flight");
		}
		sendInFlight.add(input.submissionId);
		try {
			return await runSend(deps, input);
		} finally {
			sendInFlight.delete(input.submissionId);
		}
	};

	const handler = async (envelope: Envelope): Promise<unknown> => {
		switch (envelope.method) {
			case "connectGmail":
				return await handleConnectGmail(envelope, deps);
			case "connectImap":
				return await handleConnectImap(envelope, deps);
			case "syncNow": {
				await requireServiceCapability(envelope, deps.getLedger, MAIL_MANAGE_CAP, "mail");
				const arg = objectArg(envelope);
				return await syncAccount(requireString(arg.accountRef, "accountRef", "syncNow"));
			}
			case "loadOlder": {
				await requireServiceCapability(envelope, deps.getLedger, MAIL_MANAGE_CAP, "mail");
				const arg = objectArg(envelope);
				return await loadOlder(requireString(arg.accountRef, "accountRef", "loadOlder"));
			}
			case "fetchAttachment": {
				await requireServiceCapability(envelope, deps.getLedger, MAIL_MANAGE_CAP, "mail");
				const arg = objectArg(envelope);
				return await fetchAttachment(
					requireString(arg.emailRef, "emailRef", "fetchAttachment"),
					requireString(arg.partRef, "partRef", "fetchAttachment"),
				);
			}
			case "disconnect":
				return await handleDisconnect(envelope, deps);
			default:
				throw makeError("Invalid", `unknown mail method: ${envelope.method}`);
		}
	};

	return { handler, syncAccount, send };
}

export function makeMailServiceHandler(deps: MailServiceDeps): ServiceHandler {
	return createMailService(deps).handler;
}

/** Ensure the singleton Gmail `Connector/v1` row exists and carries the
 *  current client id (the only mutable piece of its provider config). */
async function ensureGmailConnector(
	deps: MailServiceDeps,
	clientId: string,
): Promise<{ connectorRef: string; provider: ProviderConfig }> {
	const repo = await requireRepo(deps);
	const existing = findGmailConnector(repo);
	if (existing) {
		const oauth = existing.properties.oauth as Record<string, unknown> | undefined;
		if (oauth?.clientId !== clientId) {
			await deps.callEntities(MAILBOX_APP_ID, "update", {
				id: existing.id,
				patch: { oauth: { ...oauth, clientId } },
			});
		}
		return { connectorRef: existing.id, provider: gmailProvider(clientId) };
	}
	const created = (await deps.callEntities(MAILBOX_APP_ID, "create", {
		type: CONNECTOR_TYPE_URL,
		properties: {
			connectorAppId: MAILBOX_APP_ID,
			displayName: "Gmail",
			enabled: true,
			egressOrigins: [GMAIL_API_ORIGIN, GOOGLE_ACCOUNTS_ORIGIN, GOOGLE_TOKEN_ORIGIN],
			apiBaseUrl: GMAIL_API_ORIGIN,
			defaultSyncInterval: 900,
			oauth: {
				authorizeUrl: GMAIL_AUTHORIZE_URL,
				tokenUrl: GMAIL_TOKEN_URL,
				clientId,
				scopes: [...GMAIL_SCOPES],
			},
		},
	})) as { id: string };
	return { connectorRef: created.id, provider: gmailProvider(clientId) };
}

/** The connected address, from the Gmail profile endpoint. A nicety — the
 *  connect never fails over it (the account row can be relabelled later). */
async function fetchProfileAddress(
	deps: MailServiceDeps,
	connectorAccountId: string,
	provider: ProviderConfig,
): Promise<string | null> {
	try {
		const token = await deps.broker.getValidAccessToken({
			connectorAppId: MAILBOX_APP_ID,
			accountId: connectorAccountId,
			provider,
		});
		const response = await deps.egress({
			url: `${GMAIL_API_ORIGIN}/gmail/v1/users/me/profile`,
			method: "GET",
			headers: { authorization: `Bearer ${token}`, accept: "application/json" },
		});
		const profile = decodeJsonResponse<{ emailAddress?: string }>(response, "mail profile");
		return optionalString(profile.emailAddress) ?? null;
	} catch {
		return null;
	}
}

async function handleConnectGmail(
	envelope: Envelope,
	deps: MailServiceDeps,
): Promise<{ accountId: string; address: string }> {
	await requireServiceCapability(envelope, deps.getLedger, MAIL_MANAGE_CAP, "mail");
	const arg = objectArg(envelope);
	const clientId = requireString(arg.clientId, "clientId", "connectGmail");
	const clientSecret = optionalString(arg.clientSecret);
	const label = optionalString(arg.label);
	const syncWindow = isSyncWindow(arg.syncWindow) ? arg.syncWindow : SyncWindow.Days30;

	const { connectorRef, provider } = await ensureGmailConnector(deps, clientId);
	const authorized = await deps.broker.authorize({
		connectorAppId: MAILBOX_APP_ID,
		connectorRef,
		externalAccountLabel: label ?? "Gmail",
		provider,
		redirectProvider: deps.redirectProvider,
		...(clientSecret ? { clientSecret } : {}),
	});

	const address =
		(await fetchProfileAddress(deps, authorized.accountId, provider)) ?? label ?? "Gmail";
	const account = (await deps.callEntities(MAILBOX_APP_ID, "create", {
		type: MAIL_ACCOUNT_TYPE_URL,
		properties: {
			address,
			...(label ? { displayName: label } : {}),
			protocol: MailProtocol.GmailApi,
			authKind: AuthKind.OAuth2,
			syncWindow,
			enabled: true,
			connectorAccountRef: authorized.accountId,
		},
	})) as { id: string };
	return { accountId: account.id, address };
}

/** Create an IMAP+SMTP account. The app-password is sealed into Tier 2
 *  keyed by the new account's entity id — the custody invariant: the
 *  entity row never carries a secret (`validateMailAccount` would reject
 *  it structurally anyway). */
async function handleConnectImap(
	envelope: Envelope,
	deps: MailServiceDeps,
): Promise<{ accountId: string; address: string }> {
	await requireServiceCapability(envelope, deps.getLedger, MAIL_MANAGE_CAP, "mail");
	const arg = objectArg(envelope);
	const method = "connectImap";
	const address = requireString(arg.address, "address", method);
	const secret = requireString(arg.secret, "secret", method);
	const username = optionalString(arg.username) ?? address;
	const displayName = optionalString(arg.displayName);
	const incoming = requireHostConfig(arg.incoming, "incoming", method);
	const outgoing = requireHostConfig(arg.outgoing, "outgoing", method);
	const syncWindow = isSyncWindow(arg.syncWindow) ? arg.syncWindow : SyncWindow.Days30;
	const store = requireCredentialStore(deps, method);

	// Reconnect-in-place (Mailbox-13): an accountRef targets an EXISTING IMAP
	// account — re-seal the secret under the same credential key and update
	// the host config on the same entity, so synced mail and folder state
	// survive a password/host fix. The row is server-side resolved and
	// type/protocol-checked — the client's word is never trusted.
	const reconnectRef = optionalString(arg.accountRef);
	if (reconnectRef !== undefined) {
		const repo = await requireRepo(deps);
		const row = requireAccountRow(repo, reconnectRef, method);
		if (row.properties.protocol !== MailProtocol.Imap) {
			throw makeError("Invalid", `mail.${method}: account is not an IMAP account`);
		}
		await store.set(
			{ app: MAILBOX_APP_ID, key: mailAccountCredentialKey(reconnectRef) },
			new TextEncoder().encode(JSON.stringify({ secret, username })),
		);
		await deps.callEntities(MAILBOX_APP_ID, "update", {
			id: reconnectRef,
			patch: {
				address,
				...(displayName !== undefined ? { displayName } : {}),
				incoming,
				outgoing,
				syncWindow,
				enabled: true,
			},
		});
		return { accountId: reconnectRef, address };
	}

	const account = (await deps.callEntities(MAILBOX_APP_ID, "create", {
		type: MAIL_ACCOUNT_TYPE_URL,
		properties: {
			address,
			...(displayName ? { displayName } : {}),
			protocol: MailProtocol.Imap,
			authKind: AuthKind.AppPassword,
			incoming,
			outgoing,
			syncWindow,
			enabled: true,
		},
	})) as { id: string };
	try {
		await store.set(
			{ app: MAILBOX_APP_ID, key: mailAccountCredentialKey(account.id) },
			new TextEncoder().encode(JSON.stringify({ secret, username })),
		);
	} catch (error) {
		// A credential-less account can never sync — disable it rather than
		// leaving a row that fails every scheduled pass.
		await deps.callEntities(MAILBOX_APP_ID, "update", {
			id: account.id,
			patch: { enabled: false },
		});
		throw error;
	}
	return { accountId: account.id, address };
}

type ResolvedMailAccount = {
	row: EntityRow;
	repo: EntitiesRepository;
	protocol: MailProtocol.GmailApi | MailProtocol.Imap;
	credentials: DriverCredentials;
	incoming?: MailHostConfig;
	outgoing?: MailHostConfig;
	/** Gmail only — the linked `ConnectorAccount/v1` (token custody). */
	connectorAccountRef?: string;
};

function readHostConfig(value: unknown): MailHostConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const v = value as Record<string, unknown>;
	if (typeof v.host !== "string" || typeof v.port !== "number" || typeof v.tls !== "boolean") {
		return undefined;
	}
	return { host: v.host, port: v.port, tls: v.tls };
}

function requireAccountRow(
	repo: EntitiesRepository,
	accountRef: string,
	method: string,
): EntityRow {
	const row = repo.get(accountRef);
	if (!row || row.type !== MAIL_ACCOUNT_TYPE_URL) {
		throw makeError("Invalid", `mail.${method}: unknown mail account ${accountRef}`);
	}
	return row;
}

function gmailConnectorAccountRef(repo: EntitiesRepository, row: EntityRow, method: string) {
	const connectorAccountRef = optionalString(row.properties.connectorAccountRef);
	if (!connectorAccountRef) {
		throw makeError("Invalid", `mail.${method}: account has no linked connector account`);
	}
	const connector = findGmailConnector(repo);
	const oauth = connector?.properties.oauth as Record<string, unknown> | undefined;
	const clientId = optionalString(oauth?.clientId);
	if (!clientId) {
		throw makeError("Invalid", `mail.${method}: Gmail connector is missing its OAuth client id`);
	}
	return { connectorAccountRef, provider: gmailProvider(clientId) };
}

/** Resolve an account row to driver-ready transport coordinates: a fresh
 *  OAuth token (Gmail) or the Tier-2 app-password (IMAP). The secret goes
 *  straight into the worker `connect` and never toward a renderer. */
async function resolveMailAccount(
	deps: MailServiceDeps,
	accountRef: string,
	method: string,
): Promise<ResolvedMailAccount> {
	const repo = await requireRepo(deps);
	const row = requireAccountRow(repo, accountRef, method);

	if (row.properties.protocol === MailProtocol.GmailApi) {
		const { connectorAccountRef, provider } = gmailConnectorAccountRef(repo, row, method);
		const token = await deps.broker.getValidAccessToken({
			connectorAppId: MAILBOX_APP_ID,
			accountId: connectorAccountRef,
			provider,
		});
		return {
			row,
			repo,
			protocol: MailProtocol.GmailApi,
			credentials: { secret: token },
			connectorAccountRef,
		};
	}

	if (row.properties.protocol === MailProtocol.Imap) {
		const incoming = readHostConfig(row.properties.incoming);
		const outgoing = readHostConfig(row.properties.outgoing);
		if (!incoming || !outgoing) {
			throw makeError("Invalid", `mail.${method}: account is missing incoming/outgoing hosts`);
		}
		const store = requireCredentialStore(deps, method);
		const sealed = await store.get({
			app: MAILBOX_APP_ID,
			key: mailAccountCredentialKey(accountRef),
		});
		if (!sealed) {
			throw makeError("Denied", `mail.${method}: no stored credentials — reconnect the account`);
		}
		const parsed = JSON.parse(new TextDecoder().decode(sealed)) as {
			secret?: string;
			username?: string;
		};
		const secret = optionalString(parsed.secret);
		if (!secret) {
			throw makeError("Denied", `mail.${method}: stored credentials are unreadable — reconnect`);
		}
		const username = optionalString(parsed.username) ?? optionalString(row.properties.address);
		return {
			row,
			repo,
			protocol: MailProtocol.Imap,
			credentials: { secret, ...(username ? { username } : {}) },
			incoming,
			outgoing,
		};
	}

	throw makeError(
		"Unavailable",
		`mail.${method}: only ${MailProtocol.GmailApi} / ${MailProtocol.Imap} accounts are implemented`,
	);
}

/** Connect the worker-side driver for a resolved account and hand back the
 *  proxy. From here the caller MUST `close()` on every exit path. */
async function connectDriver(
	deps: MailServiceDeps,
	resolved: ResolvedMailAccount,
): Promise<MailDriver> {
	await deps.transport.connect({
		accountId: resolved.row.id,
		protocol: resolved.protocol,
		...(resolved.incoming ? { incoming: resolved.incoming } : {}),
		...(resolved.outgoing ? { outgoing: resolved.outgoing } : {}),
		credentials: resolved.credentials,
	});
	return deps.transport.driverFor(resolved.row.id, resolved.protocol);
}

/** The engine's entity ports over the active repo — shared by sync + send
 *  so every projection (received or sent mail) takes one audited path. */
function makeEnginePorts(
	deps: MailServiceDeps,
	repo: EntitiesRepository,
	accountRef: string,
	driver: MailDriver,
) {
	const findOfType = (propKey: string, value: string, type: string): EntityRow | null => {
		for (const id of repo.listIdsWithProperty(propKey, value)) {
			const candidate = repo.get(id);
			if (candidate && candidate.type === type && candidate.properties.accountRef === accountRef) {
				return candidate;
			}
		}
		return null;
	};

	return {
		driver,
		findFolderByPath: (_account: string, path: string) =>
			Promise.resolve(findOfType("path", path, MAIL_FOLDER_TYPE_URL)?.id ?? null),
		findEmailByMessageId: (_account: string, messageId: string) => {
			const email = findOfType("messageId", messageId, EMAIL_TYPE_URL);
			if (!email) return Promise.resolve(null);
			const flags = Array.isArray(email.properties.flags)
				? (email.properties.flags as MailFlag[])
				: [];
			const folderRefs = Array.isArray(email.properties.folderRefs)
				? (email.properties.folderRefs as string[])
				: [];
			return Promise.resolve({ id: email.id, flags, folderRefs });
		},
		findEmailBySubmissionId: (_account: string, submissionId: string) =>
			Promise.resolve(findOfType("submissionId", submissionId, EMAIL_TYPE_URL)?.id ?? null),
		createEntity: async (type: string, properties: Record<string, unknown>) =>
			(await deps.callEntities(MAILBOX_APP_ID, "create", { type, properties })) as { id: string },
		updateEntity: async (id: string, patch: Record<string, unknown>) => {
			await deps.callEntities(MAILBOX_APP_ID, "update", { id, patch });
		},
		listAccountFolders: () => {
			const folders: {
				id: string;
				path: string;
				backfillCursor?: string;
				backfillDone?: boolean;
			}[] = [];
			for (const id of repo.idsByTypes([MAIL_FOLDER_TYPE_URL])) {
				const row = repo.get(id);
				if (!row || row.properties.accountRef !== accountRef) continue;
				const path = optionalString(row.properties.path);
				if (path === undefined) continue;
				const backfillCursor = optionalString(row.properties.backfillCursor);
				folders.push({
					id: row.id,
					path,
					...(backfillCursor !== undefined ? { backfillCursor } : {}),
					...(row.properties.backfillDone === true ? { backfillDone: true } : {}),
				});
			}
			return Promise.resolve(folders);
		},
		loadPersonIndex: () => {
			const persons: { id: string; type: string; properties: Record<string, unknown> }[] = [];
			for (const id of repo.idsByTypes([PERSON_TYPE])) {
				const person = repo.get(id);
				if (person) persons.push(person);
			}
			return Promise.resolve(buildPersonIndex(persons));
		},
		now: deps.now ?? (() => Date.now()),
	};
}

async function runSync(deps: MailServiceDeps, accountRef: string): Promise<MailSyncResult> {
	const resolved = await resolveMailAccount(deps, accountRef, "syncNow");
	if (resolved.row.properties.enabled !== true) {
		throw makeError("Invalid", "mail.syncNow: account is disabled");
	}
	const driver = await connectDriver(deps, resolved);
	// The driver now exists in the worker; from here `close()` must run on
	// every exit path (engine setup throwing included), so the try opens here.
	try {
		const engine = new MailSyncEngine(makeEnginePorts(deps, resolved.repo, accountRef, driver));
		const syncWindow = isSyncWindow(resolved.row.properties.syncWindow)
			? resolved.row.properties.syncWindow
			: SyncWindow.Days30;
		return await engine.syncAccount({ id: accountRef, syncWindow });
	} finally {
		// Always drop the worker-side driver (and the injected secret).
		await driver.close().catch(() => {});
	}
}

async function runBackfill(deps: MailServiceDeps, accountRef: string): Promise<MailBackfillResult> {
	const resolved = await resolveMailAccount(deps, accountRef, "loadOlder");
	if (resolved.row.properties.enabled !== true) {
		throw makeError("Invalid", "mail.loadOlder: account is disabled");
	}
	const driver = await connectDriver(deps, resolved);
	try {
		const engine = new MailSyncEngine(makeEnginePorts(deps, resolved.repo, accountRef, driver));
		const syncWindow = isSyncWindow(resolved.row.properties.syncWindow)
			? resolved.row.properties.syncWindow
			: SyncWindow.Days30;
		return await engine.backfillAccount({ id: accountRef, syncWindow });
	} finally {
		await driver.close().catch(() => {});
	}
}

async function runSend(deps: MailServiceDeps, input: MailSendInput): Promise<SendResult> {
	const resolved = await resolveMailAccount(deps, input.accountRef, "send");
	if (resolved.row.properties.enabled !== true) {
		throw makeError("Invalid", "mail.send: account is disabled");
	}
	const address = optionalString(resolved.row.properties.address);
	if (!address) throw makeError("Invalid", "mail.send: account has no address");
	const displayName = optionalString(resolved.row.properties.displayName);
	const from = formatMailAddress({ address, ...(displayName ? { name: displayName } : {}) });

	const driver = await connectDriver(deps, resolved);
	try {
		const engine = new MailSyncEngine(makeEnginePorts(deps, resolved.repo, input.accountRef, driver));
		const syncWindow = isSyncWindow(resolved.row.properties.syncWindow)
			? resolved.row.properties.syncWindow
			: SyncWindow.Days30;
		return await engine.send(
			{ id: input.accountRef, syncWindow },
			{
				from,
				to: input.to,
				...(input.cc ? { cc: input.cc } : {}),
				...(input.subject !== undefined ? { subject: input.subject } : {}),
				...(input.bodyText !== undefined ? { bodyText: input.bodyText } : {}),
				...(input.bodyHtml !== undefined ? { bodyHtml: input.bodyHtml } : {}),
				submissionId: input.submissionId,
				...(input.inReplyTo !== undefined ? { inReplyTo: input.inReplyTo } : {}),
				...(input.references ? { references: input.references } : {}),
			},
		);
	} finally {
		await driver.close().catch(() => {});
	}
}

async function handleDisconnect(envelope: Envelope, deps: MailServiceDeps): Promise<{ ok: true }> {
	await requireServiceCapability(envelope, deps.getLedger, MAIL_MANAGE_CAP, "mail");
	const arg = objectArg(envelope);
	const accountRef = requireString(arg.accountRef, "accountRef", "disconnect");
	const repo = await requireRepo(deps);
	const row = requireAccountRow(repo, accountRef, "disconnect");

	if (row.properties.protocol === MailProtocol.GmailApi) {
		const { connectorAccountRef } = gmailConnectorAccountRef(repo, row, "disconnect");
		await deps.broker.revoke({ connectorAppId: MAILBOX_APP_ID, accountId: connectorAccountRef });
	} else if (row.properties.protocol === MailProtocol.Imap) {
		const store = requireCredentialStore(deps, "disconnect");
		await store.delete({ app: MAILBOX_APP_ID, key: mailAccountCredentialKey(accountRef) });
	} else {
		throw makeError("Unavailable", "mail.disconnect: unsupported account protocol");
	}
	await deps.callEntities(MAILBOX_APP_ID, "update", {
		id: accountRef,
		patch: { enabled: false },
	});
	return { ok: true };
}

export type FetchAttachmentResultView = {
	/** The `File/v1` entity now holding the bytes. */
	fileRef: string;
	name: string;
	mime: string;
	size: number;
	/** True when the part had already been fetched and no new bytes moved. */
	alreadyFetched: boolean;
};

/** The server path of the first folder the email still lives in — a message
 *  can carry several labels (Gmail), any of which can address the part. */
function folderPathForEmail(repo: EntitiesRepository, email: EntityRow): string | null {
	const refs = Array.isArray(email.properties.folderRefs) ? email.properties.folderRefs : [];
	for (const ref of refs) {
		if (typeof ref !== "string") continue;
		const folder = repo.get(ref);
		if (folder?.type !== MAIL_FOLDER_TYPE_URL) continue;
		const path = optionalString(folder.properties.path);
		if (path) return path;
	}
	return null;
}

function readAttachmentParts(value: unknown): MailAttachmentPart[] {
	if (!Array.isArray(value)) return [];
	const parts: MailAttachmentPart[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as Record<string, unknown>;
		const partRef = optionalString(candidate.partRef);
		const filename = optionalString(candidate.filename);
		if (!partRef || !filename) continue;
		const part: MailAttachmentPart = { partRef, filename };
		const mimeType = optionalString(candidate.mimeType);
		if (mimeType) part.mimeType = mimeType;
		if (typeof candidate.sizeBytes === "number") part.sizeBytes = candidate.sizeBytes;
		parts.push(part);
	}
	return parts;
}

/**
 * Materialise one attachment into a `File/v1` entity (Mailbox-6).
 *
 * Everything the fetch acts on is resolved from the stored `Email/v1` row —
 * the caller supplies only which email and which of *its* parts. A `partRef`
 * that the email does not itself declare is refused, so holding
 * `entities.write:Email/v1` cannot be turned into "fetch an arbitrary part of
 * any message in the mailbox"; the account and folder likewise come from the
 * row, never from the caller.
 */
async function runFetchAttachment(
	deps: MailServiceDeps,
	emailRef: string,
	partRef: string,
): Promise<FetchAttachmentResultView> {
	const repo = await requireRepo(deps);
	const email = repo.get(emailRef);
	if (!email || email.type !== EMAIL_TYPE_URL) {
		throw makeError("Invalid", "mail.fetchAttachment: no such email");
	}
	const part = readAttachmentParts(email.properties.attachmentParts).find(
		(p) => p.partRef === partRef,
	);
	if (!part) {
		throw makeError("Invalid", "mail.fetchAttachment: this email declares no such attachment");
	}

	const assetStore = (await deps.getAssetStore?.()) ?? null;
	if (!assetStore) {
		throw makeError("Unavailable", "mail.fetchAttachment: asset store unavailable");
	}

	// Re-fetching an already-materialised part would orphan the previous asset,
	// so the existing File entity wins.
	const existingRefs = Array.isArray(email.properties.attachments)
		? email.properties.attachments.filter((r): r is string => typeof r === "string")
		: [];
	for (const ref of existingRefs) {
		const file = repo.get(ref);
		if (file && optionalString(file.properties.mailPartRef) === partRef) {
			return {
				fileRef: ref,
				name: optionalString(file.properties.name) ?? part.filename,
				mime: optionalString(file.properties.mime) ?? servedMimeForName(part.filename),
				size: typeof file.properties.size === "number" ? file.properties.size : 0,
				alreadyFetched: true,
			};
		}
	}

	const accountRef = optionalString(email.properties.accountRef);
	if (!accountRef) {
		throw makeError("Invalid", "mail.fetchAttachment: email has no account");
	}
	const folderPath = folderPathForEmail(repo, email);
	if (!folderPath) {
		throw makeError("Invalid", "mail.fetchAttachment: email has no resolvable folder");
	}

	const resolved = await resolveMailAccount(deps, accountRef, "fetchAttachment");
	if (resolved.row.properties.enabled !== true) {
		throw makeError("Invalid", "mail.fetchAttachment: account is disabled");
	}
	const driver = await connectDriver(deps, resolved);
	let bytes: Uint8Array;
	try {
		if (!driver.fetchAttachment) {
			throw makeError("Unavailable", "mail.fetchAttachment: unsupported for this account");
		}
		({ bytes } = await driver.fetchAttachment({ folderPath, partRef }));
	} finally {
		await driver.close().catch(() => {});
	}

	// Mime comes from the filename, not the server's claim — the served type
	// decides how the renderer treats the bytes (F-421: `assetMime` or the
	// Files tile never renders a thumbnail).
	const mime = servedMimeForName(part.filename);
	const { assetId } = await assetStore.writeAsset({ bytes, mime, kind: AssetKind.Upload });
	assetStore.markBound(assetId);

	const created = (await deps.callEntities(MAILBOX_APP_ID, "create", {
		type: FILE_ENTITY_TYPE,
		properties: {
			name: part.filename,
			mime,
			assetMime: mime,
			size: bytes.length,
			assetId,
			attachment: `brainstorm://asset/${assetId}`,
			mailPartRef: partRef,
			mailEmailRef: emailRef,
		},
	})) as { id: string };

	await deps.callEntities(MAILBOX_APP_ID, "update", {
		id: emailRef,
		patch: { attachments: [...existingRefs, created.id] },
	});

	return {
		fileRef: created.id,
		name: part.filename,
		mime,
		size: bytes.length,
		alreadyFetched: false,
	};
}
