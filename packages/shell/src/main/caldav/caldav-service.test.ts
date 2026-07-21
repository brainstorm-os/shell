import { CALDAV_ACCOUNT_TYPE_URL, CALDAV_CALENDAR_TYPE_URL } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import type { Envelope } from "../../ipc/envelope";
import type { ConnectorEgress, ConnectorEgressResponse } from "../connectors/egress";
import type { EntityRow } from "../storage/entities-repo/entities-repo";
import {
	CALDAV_MANAGE_CAP,
	CALENDAR_APP_ID,
	type CalDavServiceDeps,
	makeCalDavServiceHandler,
	makeDavRequest,
} from "./caldav-service";

const BASE = "https://dav.example.com";

function envelope(method: string, arg: unknown, app = CALENDAR_APP_ID): Envelope {
	return { v: 1, msg: "m1", app, service: "caldav", method, args: [arg], caps: [] };
}

function xmlResponse(url: string, body: string, status = 207): ConnectorEgressResponse {
	return {
		status,
		headers: { "content-type": "application/xml" },
		body: new TextEncoder().encode(body),
		finalUrl: url,
	};
}

const PRINCIPAL_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:"><d:response><d:href>/.well-known/caldav</d:href>
<d:propstat><d:prop><d:current-user-principal><d:href>/principals/mira/</d:href></d:current-user-principal></d:prop>
<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

const HOME_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/principals/mira/</d:href>
<d:propstat><d:prop><c:calendar-home-set><d:href>/calendars/mira/</d:href></c:calendar-home-set></d:prop>
<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

const CALENDARS_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/calendars/mira/work/</d:href>
<d:propstat><d:prop><d:displayname>Work</d:displayname>
<d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop>
<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

const EMPTY_SYNC_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:"><d:sync-token>tok-1</d:sync-token></d:multistatus>`;

/** Route the egress like a small CalDAV server. */
function fakeEgress(): {
	egress: ConnectorEgress;
	requests: { url: string; headers: Record<string, string> }[];
} {
	const requests: { url: string; headers: Record<string, string> }[] = [];
	const egress: ConnectorEgress = (req) => {
		requests.push({ url: req.url, headers: { ...(req.headers ?? {}) } });
		const url = new URL(req.url);
		if (url.pathname === "/.well-known/caldav") {
			return Promise.resolve(xmlResponse(req.url, PRINCIPAL_XML));
		}
		if (url.pathname === "/principals/mira/") {
			return Promise.resolve(xmlResponse(req.url, HOME_XML));
		}
		if (url.pathname === "/calendars/mira/") {
			return Promise.resolve(xmlResponse(req.url, CALENDARS_XML));
		}
		if (url.pathname === "/calendars/mira/work/" && req.method === "REPORT") {
			return Promise.resolve(xmlResponse(req.url, EMPTY_SYNC_XML));
		}
		return Promise.resolve(xmlResponse(req.url, "", 404));
	};
	return { egress, requests };
}

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
	const callEntities = vi.fn((_app: string, method: string, arg: unknown): Promise<unknown> => {
		const a = arg as {
			id?: string;
			type?: string;
			properties?: Record<string, unknown>;
			patch?: Record<string, unknown>;
		};
		if (method === "create" && a.type) return Promise.resolve(insert(a.type, a.properties ?? {}));
		if (method === "update" && a.id) {
			const row = rows.get(a.id);
			if (row) Object.assign(row.properties, a.patch ?? {});
			return Promise.resolve(undefined);
		}
		if (method === "delete" && a.id) {
			rows.delete(a.id);
			return Promise.resolve(null);
		}
		throw new Error(`unexpected callEntities ${method}`);
	});
	return { rows, insert, repo, callEntities };
}

function makeCredentialStore() {
	const secrets = new Map<string, Uint8Array>();
	return {
		secrets,
		store: {
			set: (t: { app: string; key: string }, v: Uint8Array) => {
				secrets.set(`${t.app}/${t.key}`, v);
				return Promise.resolve();
			},
			get: (t: { app: string; key: string }) =>
				Promise.resolve(secrets.get(`${t.app}/${t.key}`) ?? null),
			delete: (t: { app: string; key: string }) =>
				Promise.resolve(secrets.delete(`${t.app}/${t.key}`)),
		},
	};
}

function makeDeps(overrides: Partial<CalDavServiceDeps> = {}) {
	const store = makeFakeStore();
	const creds = makeCredentialStore();
	const { egress, requests } = fakeEgress();
	const deps: CalDavServiceDeps = {
		egress,
		getRepo: () =>
			Promise.resolve(store.repo as unknown as Awaited<ReturnType<CalDavServiceDeps["getRepo"]>>),
		getCredentials: () => creds.store,
		callEntities: store.callEntities,
		now: () => Date.UTC(2026, 5, 11, 9, 0, 0),
		...overrides,
	};
	return { deps, store, creds, requests };
}

const CONNECT_ARG = {
	serverUrl: `${BASE}/`,
	username: "mira",
	password: "app-password-1",
	label: "Fastmail",
};

describe("caldav capability gate", () => {
	it("fails closed when the caller lacks caldav.manage", async () => {
		const ledger = { has: () => false };
		const { deps } = makeDeps({
			getLedger: () =>
				Promise.resolve(
					ledger as unknown as Awaited<ReturnType<NonNullable<CalDavServiceDeps["getLedger"]>>>,
				),
		});
		const handler = makeCalDavServiceHandler(deps);
		await expect(handler(envelope("connect", CONNECT_ARG, "io.evil.app"))).rejects.toMatchObject({
			name: "Denied",
		});
	});

	it("a throwing ledger maps to Unavailable, never approval", async () => {
		const { deps } = makeDeps({
			getLedger: () => Promise.reject(new Error("boom")),
		});
		const handler = makeCalDavServiceHandler(deps);
		await expect(handler(envelope("connect", CONNECT_ARG))).rejects.toThrow();
	});
});

describe("caldav.connect", () => {
	it("discovers, creates a secret-free account entity, seals the credential in Tier 2, lists calendars", async () => {
		const { deps, store, creds } = makeDeps();
		const handler = makeCalDavServiceHandler(deps);
		const result = (await handler(envelope("connect", CONNECT_ARG))) as {
			accountId: string;
			calendars: { url: string; displayName: string }[];
		};

		const account = store.rows.get(result.accountId);
		expect(account?.type).toBe(CALDAV_ACCOUNT_TYPE_URL);
		expect(account?.properties).toMatchObject({
			serverUrl: `${BASE}/`,
			principalUrl: `${BASE}/principals/mira/`,
			homeUrl: `${BASE}/calendars/mira/`,
			username: "mira",
			displayName: "Fastmail",
			enabled: true,
		});
		// Custody: no secret-shaped field on the entity, secret sealed in Tier 2.
		expect(JSON.stringify(account?.properties)).not.toContain("app-password-1");
		expect(JSON.stringify(result)).not.toContain("app-password-1");
		const sealed = creds.secrets.get(`${CALENDAR_APP_ID}/caldav:${result.accountId}`);
		expect(sealed).toBeDefined();
		expect(JSON.parse(new TextDecoder().decode(sealed))).toEqual({
			username: "mira",
			password: "app-password-1",
		});

		expect(result.calendars).toEqual([
			{
				url: `${BASE}/calendars/mira/work/`,
				displayName: "Work",
				color: null,
				supportsEvents: true,
				ctag: null,
			},
		]);
	});

	it("injects Basic auth main-side on every request", async () => {
		const { deps, requests } = makeDeps();
		const handler = makeCalDavServiceHandler(deps);
		await handler(envelope("connect", CONNECT_ARG));
		expect(requests.length).toBeGreaterThan(0);
		const expected = `Basic ${Buffer.from("mira:app-password-1").toString("base64")}`;
		for (const req of requests) {
			expect(req.headers.authorization).toBe(expected);
		}
	});

	it("rejects an invalid server URL without touching the network", async () => {
		const { deps, requests } = makeDeps();
		const handler = makeCalDavServiceHandler(deps);
		await expect(
			handler(envelope("connect", { ...CONNECT_ARG, serverUrl: "not a url" })),
		).rejects.toMatchObject({ name: "Invalid" });
		expect(requests).toHaveLength(0);
	});
});

describe("caldav egress scoping", () => {
	it("makeDavRequest refuses (and audits) a URL outside the frozen origins", async () => {
		const egress = vi.fn();
		const onRefused = vi.fn();
		const request = makeDavRequest({
			egress: egress as unknown as ConnectorEgress,
			egressOrigins: [BASE],
			credential: { username: "u", password: "p" },
			onRefused,
		});
		await expect(
			request({ method: "PROPFIND", url: "https://evil.example.net/exfil" }),
		).rejects.toMatchObject({ name: "Denied" });
		expect(egress).not.toHaveBeenCalled();
		expect(onRefused).toHaveBeenCalledWith(
			expect.objectContaining({ url: "https://evil.example.net/exfil" }),
		);
	});

	it("a caller-supplied Authorization header never wins over the injected one", async () => {
		const seen: Record<string, string>[] = [];
		const egress: ConnectorEgress = (req) => {
			seen.push({ ...(req.headers ?? {}) });
			return Promise.resolve(xmlResponse(req.url, EMPTY_SYNC_XML));
		};
		const request = makeDavRequest({
			egress,
			egressOrigins: [BASE],
			credential: { username: "u", password: "p" },
			onRefused: undefined,
		});
		await request({
			method: "REPORT",
			url: `${BASE}/calendars/mira/work/`,
			headers: { Authorization: "Bearer stolen" },
		});
		expect(seen[0]?.authorization).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
		expect(Object.values(seen[0] ?? {})).not.toContain("Bearer stolen");
	});

	it("addCalendar refuses a collection URL outside the account's origins", async () => {
		const { deps } = makeDeps();
		const handler = makeCalDavServiceHandler(deps);
		const { accountId } = (await handler(envelope("connect", CONNECT_ARG))) as {
			accountId: string;
		};
		await expect(
			handler(
				envelope("addCalendar", {
					accountRef: accountId,
					url: "https://evil.example.net/cal/",
					displayName: "Trap",
				}),
			),
		).rejects.toMatchObject({ name: "Denied" });
	});
});

describe("caldav.addCalendar / syncNow / disconnect", () => {
	async function connected() {
		const ctx = makeDeps();
		const handler = makeCalDavServiceHandler(ctx.deps);
		const { accountId } = (await handler(envelope("connect", CONNECT_ARG))) as {
			accountId: string;
		};
		return { ...ctx, handler, accountId };
	}

	it("addCalendar creates the CalDavCalendar row; syncNow runs and persists the token", async () => {
		const { handler, accountId, store } = await connected();
		const { calendarRef } = (await handler(
			envelope("addCalendar", {
				accountRef: accountId,
				url: `${BASE}/calendars/mira/work/`,
				displayName: "Work",
			}),
		)) as { calendarRef: string };
		expect(store.rows.get(calendarRef)?.type).toBe(CALDAV_CALENDAR_TYPE_URL);

		const summary = (await handler(envelope("syncNow", { calendarRef }))) as {
			pulled: number;
			conflicts: number;
		};
		expect(summary).toMatchObject({ pulled: 0, conflicts: 0 });
		expect(store.rows.get(calendarRef)?.properties.syncToken).toBe("tok-1");
		expect(store.rows.get(calendarRef)?.properties.lastSyncAt).toBeDefined();
	});

	it("syncNow on an unknown or disabled calendar is Invalid", async () => {
		const { handler, accountId, store } = await connected();
		await expect(handler(envelope("syncNow", { calendarRef: "nope" }))).rejects.toMatchObject({
			name: "Invalid",
		});
		const { calendarRef } = (await handler(
			envelope("addCalendar", {
				accountRef: accountId,
				url: `${BASE}/calendars/mira/work/`,
				displayName: "Work",
			}),
		)) as { calendarRef: string };
		const row = store.rows.get(calendarRef);
		if (row) row.properties.enabled = false;
		await expect(handler(envelope("syncNow", { calendarRef }))).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("disconnect deletes the Tier-2 credential and disables the account", async () => {
		const { handler, accountId, store, creds } = await connected();
		expect(creds.secrets.size).toBe(1);
		const result = await handler(envelope("disconnect", { accountRef: accountId }));
		expect(result).toEqual({ ok: true });
		expect(creds.secrets.size).toBe(0);
		expect(store.rows.get(accountId)?.properties.enabled).toBe(false);
		// Further use is refused — the credential is gone and the row disabled.
		await expect(handler(envelope("listCalendars", { accountRef: accountId }))).rejects.toMatchObject(
			{ name: "Invalid" },
		);
	});
});
