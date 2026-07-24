import { describe, expect, it, vi } from "vitest";
import type { CredentialKey } from "../credentials/store";
import {
	NOTION_CREDENTIAL,
	clearNotionToken,
	makeNotionTransport,
	notionTokenFromStore,
	storeNotionToken,
} from "./notion-api-transport";

function stubSession() {
	const store = new Map<string, Uint8Array>();
	const keyOf = (k: CredentialKey) => `${k.app}/${k.key}`;
	return {
		store,
		getCredential: async (k: CredentialKey) => store.get(keyOf(k)) ?? null,
		setCredential: async (k: CredentialKey, v: Uint8Array) => {
			store.set(keyOf(k), v);
		},
		deleteCredential: async (k: CredentialKey) => store.delete(keyOf(k)),
	};
}

/** A fetch stub shaped like the one `executeNetworkFetch` drives. */
function stubExecuteOptions(reply: { status?: number; body?: string } = {}) {
	const bytes = new TextEncoder().encode(reply.body ?? '{"ok":true}');
	const fetchImpl = vi.fn(
		async (
			_resolvedIp: string,
			_request: { url: string; method: string; headers: Record<string, string> },
		) => ({
			status: reply.status ?? 200,
			headers: { "content-type": "application/json" },
			body: (async function* () {
				yield bytes;
			})(),
		}),
	);
	return {
		fetchImpl: fetchImpl as never,
		// A public IP — the SSRF guard resolves the host before fetching.
		lookupHost: (async () => ["93.184.216.34"]) as never,
		auditSink: (() => undefined) as never,
		now: () => 1_700_000_000_000,
	};
}

describe("the Notion token in the vault credential store", () => {
	it("round-trips a token and trims it", async () => {
		const session = stubSession();
		await storeNotionToken(session, "  secret_abc  ");
		expect(await notionTokenFromStore(session)).toBe("secret_abc");
		expect(session.store.has(`${NOTION_CREDENTIAL.app}/${NOTION_CREDENTIAL.key}`)).toBe(true);
	});

	it("reports 'not connected' when nothing is stored or the entry is blank", async () => {
		const session = stubSession();
		expect(await notionTokenFromStore(session)).toBeNull();
		await storeNotionToken(session, "   ");
		expect(await notionTokenFromStore(session)).toBeNull();
	});

	it("clears on disconnect", async () => {
		const session = stubSession();
		await storeNotionToken(session, "secret_abc");
		expect(await clearNotionToken(session)).toBe(true);
		expect(await notionTokenFromStore(session)).toBeNull();
	});
});

describe("makeNotionTransport", () => {
	it("resolves a relative path against Notion's origin and injects auth + version", async () => {
		const executeOptions = stubExecuteOptions();
		const transport = makeNotionTransport({ token: "secret_abc", executeOptions });
		await transport({ method: "POST", path: "/v1/search", body: { page_size: 100 } });

		const call = (executeOptions.fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock
			.calls[0];
		const request = call?.[1] as { url: string; headers: Record<string, string>; method: string };
		expect(request.url).toBe("https://api.notion.com/v1/search");
		expect(request.method).toBe("POST");
		expect(request.headers.Authorization).toBe("Bearer secret_abc");
		expect(request.headers["Notion-Version"]).toBeTruthy();
	});

	it("refuses an off-origin path — the token can't be pointed at another host", async () => {
		const transport = makeNotionTransport({
			token: "secret_abc",
			executeOptions: stubExecuteOptions(),
		});
		await expect(transport({ method: "GET", path: "https://evil.test/steal" })).rejects.toThrow(
			/off-origin/,
		);
	});

	it("returns the parsed body with its status", async () => {
		const transport = makeNotionTransport({
			token: "t",
			executeOptions: stubExecuteOptions({ status: 200, body: '{"results":[]}' }),
		});
		expect(await transport({ method: "POST", path: "/v1/search" })).toEqual({
			status: 200,
			json: { results: [] },
		});
	});

	it("surfaces the status even when the body isn't JSON (an error page, say)", async () => {
		const transport = makeNotionTransport({
			token: "t",
			executeOptions: stubExecuteOptions({ status: 502, body: "<html>bad gateway</html>" }),
		});
		expect(await transport({ method: "GET", path: "/v1/users/me" })).toEqual({
			status: 502,
			json: null,
		});
	});
});
