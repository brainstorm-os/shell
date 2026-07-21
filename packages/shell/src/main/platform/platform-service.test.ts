import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import type { SqliteDatabase } from "@brainstorm-os/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "../../ipc/envelope";
import { ENVELOPE_PROTOCOL_VERSION } from "../../ipc/envelope";
import { AppSignatureStatus } from "../apps/app-signature";
import { DEFAULT_INSTALL_PROVENANCE } from "../apps/install-provenance";
import { DataStores } from "../storage/data-stores";
import { RegistryRepositories } from "../storage/registry-repo/index";
import {
	PLATFORM_READ_CAPABILITY,
	type PlatformServiceOptions,
	makePlatformServiceHandler,
} from "./platform-service";

const AGENT = "io.brainstorm.agent";

async function seededRegistry(): Promise<{
	vaultDir: string;
	stores: DataStores;
	db: SqliteDatabase;
}> {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-platform-"));
	const stores = new DataStores(vaultDir);
	const db = await stores.open("registry");
	const repos = new RegistryRepositories(db);
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
	repos.entityTypes.upsert({
		id: "brainstorm/Note/v1",
		introducedBy: "io.brainstorm.notes",
		schemaUrl: "https://brainstorm.io/schemas/note/v1.json",
		schemaInline: {
			type: "object",
			required: ["title"],
			properties: { title: { type: "string" }, pinned: { type: "boolean" } },
		},
		registeredAt: 1000,
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
	return { vaultDir, stores, db };
}

/** A ledger stub that grants exactly `held`. */
function ledgerGranting(held: ReadonlySet<string>): CapabilityLedger {
	return {
		has: (_app: string, cap: string) => held.has(cap),
	} as unknown as CapabilityLedger;
}

function envelope(caps: string[]): Envelope {
	return {
		v: ENVELOPE_PROTOCOL_VERSION,
		msg: "m1",
		app: AGENT,
		service: "platform",
		method: "catalog",
		args: [],
		caps,
	};
}

describe("platform service — catalog (doc 63)", () => {
	let env: Awaited<ReturnType<typeof seededRegistry>>;
	const baseOptions = (): PlatformServiceOptions => ({
		getRegistry: async () => env.db,
		readManifestMeta: () => ({ name: "Notes", description: "Write docs.", hasIcon: true }),
	});

	beforeEach(async () => {
		env = await seededRegistry();
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	it("returns the sanitized catalog when platform.read is held", async () => {
		const handler = makePlatformServiceHandler({
			...baseOptions(),
			getLedger: async () => ledgerGranting(new Set([PLATFORM_READ_CAPABILITY])),
		});
		const catalog = (await handler(envelope([PLATFORM_READ_CAPABILITY]))) as Awaited<
			ReturnType<typeof handler>
		> & { apps: unknown[]; entityTypes: unknown[]; intents: unknown[] };
		expect(catalog.apps).toEqual([
			{ id: "io.brainstorm.notes", name: "Notes", description: "Write docs.", hasIcon: true },
		]);
		expect(catalog.entityTypes).toEqual([
			{
				id: "brainstorm/Note/v1",
				ownerApp: "io.brainstorm.notes",
				properties: [
					{ name: "title", valueType: "string", required: true },
					{ name: "pinned", valueType: "boolean", required: false },
				],
			},
		]);
		expect(catalog.intents).toEqual([
			{ ownerApp: "io.brainstorm.notes", verb: "open", entityType: "brainstorm/Note/v1" },
		]);
	});

	it("fails closed (Denied) when the ledger lacks platform.read", async () => {
		const handler = makePlatformServiceHandler({
			...baseOptions(),
			getLedger: async () => ledgerGranting(new Set()),
		});
		await expect(handler(envelope([PLATFORM_READ_CAPABILITY]))).rejects.toMatchObject({
			name: "Denied",
		});
	});

	it("fails closed (Unavailable) when there is no active vault", async () => {
		const handler = makePlatformServiceHandler({
			getRegistry: async () => null,
			getLedger: async () => ledgerGranting(new Set([PLATFORM_READ_CAPABILITY])),
		});
		await expect(handler(envelope([PLATFORM_READ_CAPABILITY]))).rejects.toMatchObject({
			name: "Unavailable",
		});
	});

	it("rejects an unknown method", async () => {
		const handler = makePlatformServiceHandler(baseOptions());
		await expect(handler({ ...envelope([]), method: "nope" })).rejects.toMatchObject({
			name: "Invalid",
		});
	});
});
