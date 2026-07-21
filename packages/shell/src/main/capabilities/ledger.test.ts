import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_APP_CAPABILITIES,
	SHELL_IDENTITY,
	applyDefaultAppGrants,
	applyShellGrants,
} from "@brainstorm-os/capabilities/default-grants";
import {
	CapabilityLedger,
	GrantedVia,
	LedgerUnavailableError,
	parseCapability,
} from "@brainstorm-os/capabilities/ledger";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataStores } from "../storage/data-stores";

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-cap-"));
	const stores = new DataStores(vaultDir);
	const db = await stores.open("ledger");
	const ledger = new CapabilityLedger(db);
	return { vaultDir, stores, ledger };
}

describe("parseCapability", () => {
	it("splits service.verb from optional scope", () => {
		expect(parseCapability("storage.kv")).toEqual({ capability: "storage.kv", scope: null });
		expect(parseCapability("entities.read:io.example/Note/v1")).toEqual({
			capability: "entities.read",
			scope: "io.example/Note/v1",
		});
		expect(parseCapability("entities.read:*")).toEqual({
			capability: "entities.read",
			scope: "*",
		});
	});
});

describe("CapabilityLedger", () => {
	let env: Awaited<ReturnType<typeof setup>>;

	beforeEach(async () => {
		env = await setup();
	});

	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	it("grants are idempotent", () => {
		const a = env.ledger.grant({
			appId: "io.example.app",
			capability: "storage.kv",
			grantedVia: GrantedVia.Install,
		});
		const b = env.ledger.grant({
			appId: "io.example.app",
			capability: "storage.kv",
			grantedVia: GrantedVia.Install,
		});
		expect(a.id).toBe(b.id);
		expect(env.ledger.listActive("io.example.app")).toHaveLength(1);
	});

	it("distinguishes grants by scope", () => {
		env.ledger.grant({
			appId: "io.example.app",
			capability: "entities.read",
			scope: "io.example/Note/v1",
			grantedVia: GrantedVia.Install,
		});
		env.ledger.grant({
			appId: "io.example.app",
			capability: "entities.read",
			scope: "io.example/Task/v1",
			grantedVia: GrantedVia.Install,
		});
		expect(env.ledger.listActive("io.example.app")).toHaveLength(2);
	});

	it("has(): exact-scope match succeeds", () => {
		env.ledger.grant({
			appId: "io.example.app",
			capability: "entities.read",
			scope: "io.example/Note/v1",
			grantedVia: GrantedVia.Install,
		});
		expect(env.ledger.has("io.example.app", "entities.read:io.example/Note/v1")).toBe(true);
	});

	it("has(): wildcard grant matches a specific request", () => {
		env.ledger.grant({
			appId: "shell",
			capability: "entities.read",
			scope: "*",
			grantedVia: GrantedVia.Install,
		});
		expect(env.ledger.has("shell", "entities.read:io.example/Note/v1")).toBe(true);
	});

	it("has(): unscoped grant matches unscoped request", () => {
		env.ledger.grant({
			appId: "io.example.app",
			capability: "storage.kv",
			grantedVia: GrantedVia.Install,
		});
		expect(env.ledger.has("io.example.app", "storage.kv")).toBe(true);
	});

	it("has(): unscoped grant does NOT match a scoped request", () => {
		env.ledger.grant({
			appId: "io.example.app",
			capability: "entities.read",
			grantedVia: GrantedVia.Install,
		});
		expect(env.ledger.has("io.example.app", "entities.read:io.example/Note/v1")).toBe(false);
	});

	it("has(): missing grant returns false", () => {
		expect(env.ledger.has("nobody", "storage.kv")).toBe(false);
	});

	it("revoke() marks the grant inactive but keeps the row for audit", () => {
		env.ledger.grant({
			appId: "io.example.app",
			capability: "storage.kv",
			grantedVia: GrantedVia.Install,
		});
		expect(env.ledger.revoke("io.example.app", "storage.kv")).toBe(true);
		expect(env.ledger.has("io.example.app", "storage.kv")).toBe(false);
		expect(env.ledger.listActive("io.example.app")).toHaveLength(0);
		const history = env.ledger.historyFor("io.example.app", "storage.kv");
		expect(history).toHaveLength(1);
	});

	it("revoke() of an unknown grant returns false", () => {
		expect(env.ledger.revoke("ghost", "storage.kv")).toBe(false);
	});

	it("re-grant after revoke gives a fresh row, leaving the old one for audit", () => {
		env.ledger.grant({
			appId: "io.example.app",
			capability: "storage.kv",
			grantedVia: GrantedVia.Install,
		});
		env.ledger.revoke("io.example.app", "storage.kv");
		const fresh = env.ledger.grant({
			appId: "io.example.app",
			capability: "storage.kv",
			grantedVia: GrantedVia.Runtime,
		});
		expect(env.ledger.has("io.example.app", "storage.kv")).toBe(true);
		expect(fresh.grantedVia).toBe(GrantedVia.Runtime);
		expect(env.ledger.historyFor("io.example.app", "storage.kv")).toHaveLength(2);
	});

	it("revokeAllFor() drops every live grant for the app", () => {
		env.ledger.grant({ appId: "a", capability: "storage.kv", grantedVia: GrantedVia.Install });
		env.ledger.grant({
			appId: "a",
			capability: "intents.dispatch",
			scope: "open",
			grantedVia: GrantedVia.Install,
		});
		env.ledger.grant({ appId: "b", capability: "storage.kv", grantedVia: GrantedVia.Install });
		expect(env.ledger.revokeAllFor("a")).toBe(2);
		expect(env.ledger.listActive("a")).toEqual([]);
		expect(env.ledger.listActive("b")).toHaveLength(1);
	});

	it("listActive sorts by capability+scope for stable display", () => {
		env.ledger.grant({
			appId: "a",
			capability: "intents.dispatch",
			scope: "open",
			grantedVia: GrantedVia.Install,
		});
		env.ledger.grant({ appId: "a", capability: "storage.kv", grantedVia: GrantedVia.Install });
		env.ledger.grant({
			appId: "a",
			capability: "credentials.read",
			scope: "self",
			grantedVia: GrantedVia.Install,
		});
		const names = env.ledger.listActive("a").map((g) => g.capability);
		expect(names).toEqual([...names].sort());
	});

	it("LedgerUnavailableError fires when SQL fails (DB closed)", () => {
		env.stores.close();
		expect(() => env.ledger.has("io.example.app", "storage.kv")).toThrow(LedgerUnavailableError);
	});
});

describe("default grants", () => {
	let env: Awaited<ReturnType<typeof setup>>;

	beforeEach(async () => {
		env = await setup();
	});

	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	it("applyDefaultAppGrants gives storage.kv + intents.dispatch:open + credentials.{read,write}:self + properties.{read,write} + search.read", () => {
		applyDefaultAppGrants(env.ledger, "io.example.app");
		expect(env.ledger.has("io.example.app", "storage.kv")).toBe(true);
		expect(env.ledger.has("io.example.app", "intents.dispatch:open")).toBe(true);
		expect(env.ledger.has("io.example.app", "credentials.read:self")).toBe(true);
		expect(env.ledger.has("io.example.app", "credentials.write:self")).toBe(true);
		expect(env.ledger.has("io.example.app", "properties.read")).toBe(true);
		expect(env.ledger.has("io.example.app", "properties.write")).toBe(true);
		expect(env.ledger.has("io.example.app", "search.read")).toBe(true);
		// The scoped grant must NOT be reachable via an unscoped request:
		// the SDK once sent the bare `intents.dispatch` hint, which silently
		// denied every cross-app open. The hint must carry the verb scope.
		expect(env.ledger.has("io.example.app", "intents.dispatch")).toBe(false);
	});

	it("applyDefaultAppGrants does NOT grant broad entity access", () => {
		applyDefaultAppGrants(env.ledger, "io.example.app");
		expect(env.ledger.has("io.example.app", "entities.read:io.example/Note/v1")).toBe(false);
	});

	it("applyDefaultAppGrants is idempotent", () => {
		applyDefaultAppGrants(env.ledger, "io.example.app");
		applyDefaultAppGrants(env.ledger, "io.example.app");
		// One active grant per default capability — no duplication on
		// re-apply. Asserted against the source list so it can't go stale
		// as default grants are added (covers.*, blocks.read, …).
		expect(env.ledger.listActive("io.example.app").length).toBe(DEFAULT_APP_CAPABILITIES.length);
	});

	it("applyShellGrants gives the shell broad capabilities", () => {
		applyShellGrants(env.ledger);
		expect(env.ledger.has(SHELL_IDENTITY, "entities.read:any.type/v1")).toBe(true);
		expect(env.ledger.has(SHELL_IDENTITY, "entities.write:any.type/v1")).toBe(true);
		expect(env.ledger.has(SHELL_IDENTITY, "identity.sign")).toBe(true);
		expect(env.ledger.has(SHELL_IDENTITY, "ai.use")).toBe(true);
	});
});
