/**
 * Integration: the platform catalog round-trips through the real IPC broker,
 * fail-closed (doc 63 — the Agent context layer). Proves the composition the
 * unit tests can't: the SDK proxy's declared `platform.read` cap, the broker's
 * generic capability gate (over a real {@link CapabilityLedger}), the service
 * handler's own ledger re-check, and the registry repos — wired together as in
 * production. The agent only gets the catalog when the ledger actually grants
 * `platform.read`; without the grant the broker denies before the handler runs.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityLedger, GrantedVia } from "@brainstorm-os/capabilities/ledger";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Broker } from "../../ipc/broker";
import { makeEnvelope } from "../../ipc/envelope";
import { AppSignatureStatus } from "../apps/app-signature";
import { DEFAULT_INSTALL_PROVENANCE } from "../apps/install-provenance";
import { DataStores } from "../storage/data-stores";
import { RegistryRepositories } from "../storage/registry-repo/index";
import { PLATFORM_READ_CAPABILITY, makePlatformServiceHandler } from "./platform-service";

const AGENT = "io.brainstorm.agent";

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-platform-pipe-"));
	const stores = new DataStores(vaultDir);
	const registry = await stores.open("registry");
	const ledger = new CapabilityLedger(await stores.open("ledger"));
	const repos = new RegistryRepositories(registry);
	repos.apps.upsert({
		id: "io.brainstorm.notes",
		version: "1.0.0",
		sdk: "1",
		manifestPath: "/p/manifest.json",
		bundleDir: "/p",
		bundleSha256: "a".repeat(64),
		installedAt: 1000,
		updatedAt: 1000,
		signatureStatus: AppSignatureStatus.Unsigned,
		signatureKeyId: null,
		...DEFAULT_INSTALL_PROVENANCE,
	});
	repos.intents.insert({
		appId: "io.brainstorm.notes",
		verb: "open",
		entityType: "brainstorm/Note/v1",
		mime: null,
		format: null,
		kind: null,
		blockId: null,
		label: null,
		priority: "primary",
		registeredAt: 1000,
	});

	const handler = makePlatformServiceHandler({
		getRegistry: async () => registry,
		getLedger: async () => ledger,
		readManifestMeta: () => ({ name: "Notes", hasIcon: true }),
	});
	// Mirror broker-context: every declared cap must be a live grant.
	const broker = new Broker({
		services: new Map([["platform", handler]]),
		checkCapability: (app, _s, _m, declaredCaps) => declaredCaps.every((cap) => ledger.has(app, cap)),
	});
	return { vaultDir, stores, ledger, broker };
}

function catalogEnvelope() {
	return makeEnvelope({
		msg: "m1",
		app: AGENT,
		service: "platform",
		method: "catalog",
		args: [],
		caps: [PLATFORM_READ_CAPABILITY],
	});
}

describe("platform catalog — broker round-trip (doc 63)", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	it("returns the catalog when the ledger grants platform.read", async () => {
		env.ledger.grant({
			appId: AGENT,
			capability: PLATFORM_READ_CAPABILITY,
			grantedVia: GrantedVia.Install,
		});
		const reply = await env.broker.dispatch(catalogEnvelope(), "test");
		expect(reply.ok).toBe(true);
		const value = reply.ok === true ? (reply.value as { apps: { id: string }[] }) : { apps: [] };
		expect(value.apps.map((a) => a.id)).toContain("io.brainstorm.notes");
	});

	it("is denied fail-closed at the broker when platform.read is not granted", async () => {
		const reply = await env.broker.dispatch(catalogEnvelope(), "test");
		expect(reply.ok).toBe(false);
		expect(reply.ok === false && reply.error.kind).toBe("CapabilityDenied");
	});
});
