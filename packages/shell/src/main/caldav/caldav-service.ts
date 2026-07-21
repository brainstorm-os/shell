/**
 * 9.15.19 — the app-facing `caldav` broker service: account connect /
 * calendar listing / subscribe / two-way sync / disconnect, riding the
 * connector framework's custody + egress posture (doc 56) with the
 * `CalDavSyncEngine` as the data path.
 *
 * Custody: the Basic credential (username + app-password) is sealed in
 * Tier 2 (`CredentialStore`, key `caldav:<accountId>` in the Calendar
 * app's keyspace) the moment `connect` validates it; it never lands on an
 * entity, is never returned, and the `Authorization` header is injected
 * main-side per request — the renderer only ever holds entity refs.
 * Google's OAuth-only CalDAV endpoint is deliberately out of the v1
 * surface (it needs the OAuth broker's consent flow — same seam as
 * `mail.connectGmail`, recorded as residue).
 *
 * Egress: every URL the client touches is validated against the
 * account's **frozen egress origins** (the entered server + the origins
 * discovery itself landed on) via the same `validateConnectorRequest`
 * check `connectors.request` uses, then rides the shared audited
 * `ConnectorEgress` (Net-1 SSRF guard + caps + per-host audit). Never raw
 * fetch. Every method is re-checked server-side against `caldav.manage`.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import {
	CALDAV_ACCOUNT_TYPE_URL,
	CALDAV_CALENDAR_REF_PROP,
	CALDAV_CALENDAR_TYPE_URL,
	type CalDavCalendarInfo,
	type CalDavSyncSummary,
	validateCalDavAccount,
	validateConnectorRequest,
} from "@brainstorm-os/sdk-types";
import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import { requireServiceCapability } from "../connectors/connectors-service";
import type { ConnectorEgress } from "../connectors/egress";
import type { EntitiesRepository, EntityRow } from "../storage/entities-repo/entities-repo";
import { CalDavClient, type DavRequestFn, type DavResult } from "./caldav-client";
import {
	CalDavSyncEngine,
	type CalDavSyncOutcome,
	EVENT_TYPE_URL,
	type LocalEventRow,
} from "./caldav-sync-engine";

export const CALDAV_MANAGE_CAP = "caldav.manage";
export const CALENDAR_APP_ID = "io.brainstorm.calendar";

const CREDENTIAL_KEY_PREFIX = "caldav:";
const MAX_BODY_PREVIEW = 64 * 1024 * 1024; // decoded text cap, defensive

export type CalDavCredentialStorePort = {
	set(target: { app: string; key: string }, value: Uint8Array): Promise<void>;
	get(target: { app: string; key: string }): Promise<Uint8Array | null>;
	delete(target: { app: string; key: string }): Promise<boolean>;
};

export type CalDavServiceDeps = {
	egress: ConnectorEgress;
	getRepo: () => Promise<EntitiesRepository | null>;
	getCredentials: () => CalDavCredentialStorePort | null;
	/** Calendar-attributed entities write (capability-checked under the
	 *  calendar app identity — same shape as the connector wiring). */
	callEntities: (app: string, method: string, arg: unknown) => Promise<unknown>;
	getLedger?: () => Promise<CapabilityLedger | null>;
	onRefused?: (info: { app: string; url: string; reason: string }) => void;
	now?: () => number;
};

function makeError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

function objectArg(envelope: Envelope): Record<string, unknown> {
	const [arg] = envelope.args as [unknown];
	if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
		throw makeError("Invalid", `caldav.${envelope.method}: argument must be an object`);
	}
	return arg as Record<string, unknown>;
}

function requireString(value: unknown, field: string, method: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw makeError("Invalid", `caldav.${method}: { ${field} } must be a non-empty string`);
	}
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function requireRepo(deps: CalDavServiceDeps): Promise<EntitiesRepository> {
	const repo = await deps.getRepo();
	if (!repo) throw makeError("Unavailable", "caldav: no active vault session");
	return repo;
}

function requireCredentials(deps: CalDavServiceDeps): CalDavCredentialStorePort {
	const store = deps.getCredentials();
	if (!store) throw makeError("Unavailable", "caldav: no active vault session");
	return store;
}

function credentialKey(accountId: string): { app: string; key: string } {
	return { app: CALENDAR_APP_ID, key: `${CREDENTIAL_KEY_PREFIX}${accountId}` };
}

function originOf(url: string, context: string): string {
	try {
		return new URL(url).origin;
	} catch {
		throw makeError("Invalid", `caldav.${context}: invalid URL "${url}"`);
	}
}

type BasicCredential = { username: string; password: string };

/** The auth-injecting, origin-scoped DAV transport — the only way the
 *  client reaches the network. Mirrors `connectors.request`'s posture:
 *  fail closed + audited on any out-of-scope URL, auth main-side only. */
export function makeDavRequest(input: {
	egress: ConnectorEgress;
	egressOrigins: readonly string[];
	credential: BasicCredential;
	onRefused?: ((info: { app: string; url: string; reason: string }) => void) | undefined;
}): DavRequestFn {
	const authorization = `Basic ${Buffer.from(
		`${input.credential.username}:${input.credential.password}`,
		"utf8",
	).toString("base64")}`;
	return async (req): Promise<DavResult> => {
		const decision = validateConnectorRequest(input.egressOrigins, req.url);
		if (!decision.allowed) {
			input.onRefused?.({ app: CALENDAR_APP_ID, url: req.url, reason: decision.reason });
			throw makeError(
				"Denied",
				`caldav: ${req.url} is outside the account's egress origins (${decision.reason})`,
			);
		}
		const headers: Record<string, string> = { ...(req.headers ?? {}) };
		// The shell owns auth — a caller-supplied header never wins.
		for (const key of Object.keys(headers)) {
			if (key.toLowerCase() === "authorization") delete headers[key];
		}
		headers.authorization = authorization;
		const response = await input.egress({
			url: req.url,
			method: req.method,
			headers,
			...(req.body !== undefined ? { body: new TextEncoder().encode(req.body) } : {}),
		});
		const body =
			response.body.length > MAX_BODY_PREVIEW
				? ""
				: new TextDecoder("utf-8", { fatal: false }).decode(response.body);
		return {
			status: response.status,
			headers: response.headers,
			body,
			finalUrl: response.finalUrl,
		};
	};
}

export function makeCalDavServiceHandler(deps: CalDavServiceDeps): ServiceHandler {
	// One sync per calendar at a time — find-then-create upserts are not
	// transactional, so a concurrent pair could duplicate rows.
	const syncInFlight = new Set<string>();
	return async (envelope: Envelope): Promise<unknown> => {
		await requireServiceCapability(envelope, deps.getLedger, CALDAV_MANAGE_CAP, "caldav");
		switch (envelope.method) {
			case "connect":
				return await handleConnect(envelope, deps);
			case "listCalendars":
				return await handleListCalendars(envelope, deps);
			case "addCalendar":
				return await handleAddCalendar(envelope, deps);
			case "syncNow":
				return await handleSyncNow(envelope, deps, syncInFlight);
			case "disconnect":
				return await handleDisconnect(envelope, deps);
			default:
				throw makeError("Invalid", `unknown caldav method: ${envelope.method}`);
		}
	};
}

function toCalendarInfo(collection: {
	url: string;
	displayName: string;
	color: string | null;
	supportsEvents: boolean;
	ctag: string | null;
}): CalDavCalendarInfo {
	return collection;
}

async function handleConnect(
	envelope: Envelope,
	deps: CalDavServiceDeps,
): Promise<{ accountId: string; calendars: CalDavCalendarInfo[] }> {
	const arg = objectArg(envelope);
	const serverUrl = requireString(arg.serverUrl, "serverUrl", "connect");
	const username = requireString(arg.username, "username", "connect");
	const password = requireString(arg.password, "password", "connect");
	const label = optionalString(arg.label);

	const serverOrigin = originOf(serverUrl, "connect");
	const credential: BasicCredential = { username, password };

	// Discovery pre-flight under the entered origin only — a server whose
	// principal/home jump origins widens the frozen list below, but the
	// jump itself must still pass the SSRF-guarded egress.
	const probeClient = new CalDavClient(
		makeDavRequest({
			egress: deps.egress,
			egressOrigins: [serverOrigin],
			credential,
			onRefused: deps.onRefused,
		}),
	);
	let discovered: { principalUrl: string; homeUrl: string };
	try {
		discovered = await probeClient.discover(serverUrl);
	} catch (error) {
		throw makeError(
			"Invalid",
			`caldav.connect: discovery failed — ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const egressOrigins = [
		...new Set([
			serverOrigin,
			originOf(discovered.principalUrl, "connect"),
			originOf(discovered.homeUrl, "connect"),
		]),
	];

	const accountDef = {
		serverUrl,
		principalUrl: discovered.principalUrl,
		homeUrl: discovered.homeUrl,
		username,
		displayName: label ?? serverOrigin,
		egressOrigins,
		enabled: true,
	};
	const issues = validateCalDavAccount(accountDef);
	if (issues.length > 0) {
		throw makeError("Invalid", `caldav.connect: ${issues[0]?.message ?? "invalid account"}`);
	}

	const account = (await deps.callEntities(CALENDAR_APP_ID, "create", {
		type: CALDAV_ACCOUNT_TYPE_URL,
		properties: accountDef,
	})) as { id: string };
	await requireCredentials(deps).set(
		credentialKey(account.id),
		new TextEncoder().encode(JSON.stringify(credential)),
	);

	const client = new CalDavClient(
		makeDavRequest({ egress: deps.egress, egressOrigins, credential, onRefused: deps.onRefused }),
	);
	const calendars = (await client.listCalendars(discovered.homeUrl)).map(toCalendarInfo);
	return { accountId: account.id, calendars };
}

type ResolvedCalDavAccount = {
	row: EntityRow;
	homeUrl: string;
	egressOrigins: string[];
	client: CalDavClient;
};

async function resolveAccount(
	deps: CalDavServiceDeps,
	accountRef: string,
	method: string,
): Promise<ResolvedCalDavAccount> {
	const repo = await requireRepo(deps);
	const row = repo.get(accountRef);
	if (!row || row.type !== CALDAV_ACCOUNT_TYPE_URL) {
		throw makeError("Invalid", `caldav.${method}: unknown CalDAV account ${accountRef}`);
	}
	if (row.properties.enabled !== true) {
		throw makeError("Invalid", `caldav.${method}: account is disabled`);
	}
	const homeUrl = optionalString(row.properties.homeUrl);
	const egressOrigins = Array.isArray(row.properties.egressOrigins)
		? row.properties.egressOrigins.filter((o): o is string => typeof o === "string")
		: [];
	if (!homeUrl || egressOrigins.length === 0) {
		throw makeError("Invalid", `caldav.${method}: account row is missing its server coordinates`);
	}

	const bytes = await requireCredentials(deps).get(credentialKey(accountRef));
	if (!bytes) {
		throw makeError("Denied", `caldav.${method}: account has no stored credential — reconnect`);
	}
	const credential = JSON.parse(new TextDecoder().decode(bytes)) as BasicCredential;

	const client = new CalDavClient(
		makeDavRequest({ egress: deps.egress, egressOrigins, credential, onRefused: deps.onRefused }),
	);
	return { row, homeUrl, egressOrigins, client };
}

async function handleListCalendars(
	envelope: Envelope,
	deps: CalDavServiceDeps,
): Promise<CalDavCalendarInfo[]> {
	const arg = objectArg(envelope);
	const accountRef = requireString(arg.accountRef, "accountRef", "listCalendars");
	const account = await resolveAccount(deps, accountRef, "listCalendars");
	return (await account.client.listCalendars(account.homeUrl)).map(toCalendarInfo);
}

async function handleAddCalendar(
	envelope: Envelope,
	deps: CalDavServiceDeps,
): Promise<{ calendarRef: string }> {
	const arg = objectArg(envelope);
	const accountRef = requireString(arg.accountRef, "accountRef", "addCalendar");
	const url = requireString(arg.url, "url", "addCalendar");
	const displayName = requireString(arg.displayName, "displayName", "addCalendar");
	const color = optionalString(arg.color);

	const account = await resolveAccount(deps, accountRef, "addCalendar");
	const decision = validateConnectorRequest(account.egressOrigins, url);
	if (!decision.allowed) {
		deps.onRefused?.({ app: envelope.app, url, reason: decision.reason });
		throw makeError(
			"Denied",
			`caldav.addCalendar: ${url} is outside the account's egress origins (${decision.reason})`,
		);
	}

	const created = (await deps.callEntities(CALENDAR_APP_ID, "create", {
		type: CALDAV_CALENDAR_TYPE_URL,
		properties: {
			accountRef,
			url,
			displayName,
			...(color ? { color } : {}),
			enabled: true,
			knownHrefs: {},
		},
	})) as { id: string };
	return { calendarRef: created.id };
}

async function handleSyncNow(
	envelope: Envelope,
	deps: CalDavServiceDeps,
	syncInFlight: Set<string>,
): Promise<CalDavSyncSummary> {
	const arg = objectArg(envelope);
	const calendarRef = requireString(arg.calendarRef, "calendarRef", "syncNow");
	if (syncInFlight.has(calendarRef)) {
		throw makeError("Unavailable", "caldav.syncNow: a sync is already running for this calendar");
	}
	syncInFlight.add(calendarRef);
	try {
		return await runSync(deps, calendarRef);
	} finally {
		syncInFlight.delete(calendarRef);
	}
}

async function runSync(deps: CalDavServiceDeps, calendarRef: string): Promise<CalDavSyncSummary> {
	const repo = await requireRepo(deps);
	const calendarRow = repo.get(calendarRef);
	if (!calendarRow || calendarRow.type !== CALDAV_CALENDAR_TYPE_URL) {
		throw makeError("Invalid", `caldav.syncNow: unknown CalDAV calendar ${calendarRef}`);
	}
	if (calendarRow.properties.enabled !== true) {
		throw makeError("Invalid", "caldav.syncNow: calendar is disabled");
	}
	const accountRef = optionalString(calendarRow.properties.accountRef);
	const calendarUrl = optionalString(calendarRow.properties.url);
	if (!accountRef || !calendarUrl) {
		throw makeError("Invalid", "caldav.syncNow: calendar row is missing its coordinates");
	}
	const account = await resolveAccount(deps, accountRef, "syncNow");

	const now = deps.now ?? (() => Date.now());
	const engine = new CalDavSyncEngine({
		client: account.client,
		listLocalEvents: async (ref): Promise<LocalEventRow[]> => {
			const liveRepo = await requireRepo(deps);
			const rows: LocalEventRow[] = [];
			for (const id of liveRepo.listIdsWithProperty(CALDAV_CALENDAR_REF_PROP, ref)) {
				const row = liveRepo.get(id);
				if (row && row.type === EVENT_TYPE_URL) {
					rows.push({ id: row.id, properties: row.properties });
				}
			}
			return rows;
		},
		createEntity: async (type, properties) =>
			(await deps.callEntities(CALENDAR_APP_ID, "create", { type, properties })) as {
				id: string;
			},
		updateEntity: async (id, patch) => {
			await deps.callEntities(CALENDAR_APP_ID, "update", { id, patch });
		},
		deleteEntity: async (id) => {
			await deps.callEntities(CALENDAR_APP_ID, "delete", { id });
		},
		now,
		newUid: () => randomUUID(),
	});

	const knownHrefs =
		calendarRow.properties.knownHrefs && typeof calendarRow.properties.knownHrefs === "object"
			? (calendarRow.properties.knownHrefs as Record<string, string>)
			: {};
	const outcome: CalDavSyncOutcome = await engine.syncCalendar({
		calendarRef,
		calendarUrl,
		syncToken: optionalString(calendarRow.properties.syncToken) ?? null,
		knownHrefs,
	});

	await deps.callEntities(CALENDAR_APP_ID, "update", {
		id: calendarRef,
		patch: {
			knownHrefs: outcome.knownHrefs,
			...(outcome.nextSyncToken !== null ? { syncToken: outcome.nextSyncToken } : {}),
			lastSyncAt: outcome.summary.finishedAt,
		},
	});
	return outcome.summary;
}

async function handleDisconnect(
	envelope: Envelope,
	deps: CalDavServiceDeps,
): Promise<{ ok: true }> {
	const arg = objectArg(envelope);
	const accountRef = requireString(arg.accountRef, "accountRef", "disconnect");
	const repo = await requireRepo(deps);
	const row = repo.get(accountRef);
	if (!row || row.type !== CALDAV_ACCOUNT_TYPE_URL) {
		throw makeError("Invalid", `caldav.disconnect: unknown CalDAV account ${accountRef}`);
	}
	await requireCredentials(deps).delete(credentialKey(accountRef));
	await deps.callEntities(CALENDAR_APP_ID, "update", {
		id: accountRef,
		patch: { enabled: false },
	});
	return { ok: true };
}
