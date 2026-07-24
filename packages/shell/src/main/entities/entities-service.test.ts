import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CapabilityLedger, LedgerUnavailableError } from "@brainstorm-os/capabilities/ledger";
import {
	AGENT_PROVENANCE_PROPERTY_KEY,
	ENTITY_PROPS_MAP_NAME,
	UNIVERSAL_BODY_FRAGMENT_NAME,
	readAgentProvenance,
} from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { ENVELOPE_PROTOCOL_VERSION, type Envelope } from "../../ipc/envelope";
import { AssetKind, AssetRefRole } from "../assets/asset-types";
import { generateSymmetricKey } from "../credentials/crypto";
import { DataStores } from "../storage/data-stores";
import {
	AssetsRepository,
	EntitiesRepository,
	EntityDeksRepository,
} from "../storage/entities-repo";
import { makeEntitiesServiceHandler } from "./entities-service";
import { EntityDekStore } from "./entity-dek-store";
import { readEntityDocProjection, writeEntityLinks, writeEntityProps } from "./entity-doc-codec";

function bytesToBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}
function base64ToBytes(encoded: string): Uint8Array {
	return new Uint8Array(Buffer.from(encoded, "base64"));
}

/** Ledger fake: a grant set of literal `capability:scope` strings; a
 *  `*`-scoped grant matches any scope for that capability (like the real
 *  ledger's wildcard rule). */
function fakeLedger(grants: string[]): CapabilityLedger {
	return {
		has(_app: string, required: string): boolean {
			const [cap] = required.split(":");
			return grants.includes(required) || grants.includes(`${cap}:*`);
		},
	} as unknown as CapabilityLedger;
}

function env(app: string, method: string, arg: unknown): Envelope {
	return {
		v: ENVELOPE_PROTOCOL_VERSION,
		msg: "m",
		app,
		service: "entities",
		method,
		args: [arg],
		caps: [],
	};
}

let ids = 0;

async function setup(grants: string[] = ["entities.read:*", "entities.write:*"]) {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-ent-svc-"));
	const stores = new DataStores(vaultDir);
	const db = await stores.open("entities");
	const repo = new EntitiesRepository(db);
	const dekRepo = new EntityDeksRepository(db);
	// Asset-B4 — a real assets repo over the same entities.db backs the
	// asset-kind lookup; `assetKindThrows` forces the reconcile-throw path.
	const assets = new AssetsRepository(db);
	let assetKindThrows = false;
	let assetBoundThrows = false;
	const assetBoundCalls: Array<{ entityId: string; assetId: string }> = [];
	const masterKey = generateSymmetricKey();
	const dekStore = new EntityDekStore(dekRepo, masterKey);
	let ledger: CapabilityLedger = fakeLedger(grants);
	const ydocCalls: Array<{
		method: string;
		entityId: string;
		updateB64: string | undefined;
	}> = [];
	const deliverCalls: Array<{
		entityId: string;
		updateB64: string;
		targets: readonly string[];
	}> = [];
	// 9.3.2d — apps `deliverDocUpdate` should report as "no live window"
	// (renderer died without closeDoc). Default: none dead.
	let deadApps: readonly string[] = [];
	let vaultPath: string | null = "/vault";
	let loadTruncated = false;
	const truncatedCalls: string[] = [];
	// 10.12 — live-sync hook capture.
	const docOpenedCalls: Array<{ entityId: string; type: string }> = [];
	const localUpdateCalls: Array<{ entityId: string; type: string; update: Uint8Array }> = [];
	const docCompactedCalls: Array<{ entityId: string; type: string }> = [];
	let compactNext = false;
	let applyRemoteDoc: ((entityId: string, updateB64: string) => Promise<void>) | null = null;
	const handler = makeEntitiesServiceHandler({
		getRepo: async () => repo,
		getLedger: async () => ledger,
		getDekStore: async () => dekStore,
		newId: () => `ent_${++ids}`,
		now: () => 1000,
		getVaultPath: () => vaultPath,
		ydoc: async (method, a) => {
			ydocCalls.push({ method, entityId: a.entityId, updateB64: a.updateB64 });
			if (method === "load") return { snapshotB64: "AQID", truncatedTail: loadTruncated };
			if (method === "applyUpdate") return { compacted: compactNext, sizeBytes: 3 };
			// 10.12 — the real worker returns the persisted update bytes from a
			// property write so the service can emit it through live-sync.
			if (method === "setEntityState") return { updateB64: "AQID" };
			return { closed: true };
		},
		deliverDocUpdate: (entityId, updateB64, targets) => {
			deliverCalls.push({ entityId, updateB64, targets });
			return deadApps;
		},
		onTruncatedTail: (id) => truncatedCalls.push(id),
		onDocOpened: (entityId, type) => docOpenedCalls.push({ entityId, type }),
		onLocalDocUpdate: (entityId, type, update) => localUpdateCalls.push({ entityId, type, update }),
		onDocCompacted: (entityId, type) => docCompactedCalls.push({ entityId, type }),
		bindApplyRemoteDoc: (fn) => {
			applyRemoteDoc = fn;
		},
		// Asset-B4 — resolve a locally-stored asset's kind (drives + gates the
		// implicit asset-ref bind writer).
		getAssetKind: async (id) => {
			if (assetKindThrows) throw new Error("boom-getAssetKind");
			return assets.getById(id)?.kind ?? null;
		},
		// Asset-B4 — record immediate per-bind upload triggers.
		onAssetBound: (entityId, assetId) => {
			if (assetBoundThrows) throw new Error("boom-onAssetBound");
			assetBoundCalls.push({ entityId, assetId });
		},
	});
	// Asset-B4 — seed a locally-stored asset so a `brainstorm://asset/<id>`
	// URL in an entity's properties resolves + binds.
	const seedAsset = (assetId: string, kind: AssetKind): void => {
		assets.create({
			assetId,
			dekId: `dek_${assetId}`,
			contentHash: `hash_${assetId}`,
			mime: "image/png",
			byteLen: 8,
			kind,
			now: 500,
		});
	};
	return {
		assets,
		seedAsset,
		setAssetKindThrows: (v: boolean) => {
			assetKindThrows = v;
		},
		assetBoundCalls,
		setAssetBoundThrows: (v: boolean) => {
			assetBoundThrows = v;
		},
		vaultDir,
		stores,
		db,
		repo,
		dekRepo,
		handler,
		ydocCalls,
		deliverCalls,
		truncatedCalls,
		docOpenedCalls,
		localUpdateCalls,
		docCompactedCalls,
		setCompactNext: (v: boolean) => {
			compactNext = v;
		},
		getApplyRemoteDoc: () => applyRemoteDoc,
		setLedger: (l: CapabilityLedger) => {
			ledger = l;
		},
		setDeadApps: (apps: readonly string[]) => {
			deadApps = apps;
		},
		setVaultPath: (p: string | null) => {
			vaultPath = p;
		},
		setLoadTruncated: (v: boolean) => {
			loadTruncated = v;
		},
	};
}

describe("entities service handler", () => {
	let e: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		e = await setup();
	});
	afterEach(async () => {
		e.stores.close();
		await rm(e.vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	it("create stamps createdBy = calling app and persists", async () => {
		const created = (await e.handler(
			env("io.x", "create", { type: "io.x/Note/v1", properties: { t: 1 } }),
		)) as { id: string; createdBy: string; properties: unknown };
		expect(created.createdBy).toBe("io.x");
		expect(created.properties).toEqual({ t: 1 });
		expect(e.repo.get(created.id)).not.toBeNull();
	});

	// ── Agent-11c: server-authoritative provenance stamping ─────────────
	it("create stamps server-authoritative provenance (agent = calling app) from a provenance arg", async () => {
		const created = (await e.handler(
			env("io.brainstorm.agent", "create", {
				type: "io.x/Note/v1",
				properties: { title: "N" },
				provenance: { conversationId: "ent_conv_1" },
			}),
		)) as { id: string; properties: Record<string, unknown> };
		const prov = readAgentProvenance(created.properties);
		expect(prov).toEqual({
			agent: "io.brainstorm.agent",
			conversationId: "ent_conv_1",
			createdAt: 1000,
		});
		// Persisted on the row, not just the response.
		expect(readAgentProvenance(e.repo.get(created.id)?.properties)?.agent).toBe(
			"io.brainstorm.agent",
		);
	});

	it("create forces the agent from envelope.app, ignoring a client-supplied agent in the provenance arg", async () => {
		const created = (await e.handler(
			env("io.x", "create", {
				type: "io.x/Note/v1",
				properties: {},
				// A malicious app tries to attribute the create to a different agent.
				provenance: { conversationId: "ent_conv_1", agent: "io.brainstorm.agent" },
			}),
		)) as { id: string; properties: Record<string, unknown> };
		expect(readAgentProvenance(created.properties)?.agent).toBe("io.x");
	});

	it("create STRIPS a forged provenance key smuggled in plain properties", async () => {
		const created = (await e.handler(
			env("io.x", "create", {
				type: "io.x/Note/v1",
				properties: {
					title: "N",
					[AGENT_PROVENANCE_PROPERTY_KEY]: {
						agent: "io.brainstorm.agent",
						conversationId: "c",
						createdAt: 1,
					},
				},
			}),
		)) as { id: string; properties: Record<string, unknown> };
		// No provenance arg → the smuggled key is dropped, nothing re-stamped.
		expect(AGENT_PROVENANCE_PROPERTY_KEY in created.properties).toBe(false);
	});

	it("create with a provenance arg overrides a forged plain-property key with the server stamp", async () => {
		const created = (await e.handler(
			env("io.x", "create", {
				type: "io.x/Note/v1",
				properties: {
					[AGENT_PROVENANCE_PROPERTY_KEY]: {
						agent: "io.brainstorm.agent",
						conversationId: "forged",
						createdAt: 1,
					},
				},
				provenance: { conversationId: "ent_real" },
			}),
		)) as { id: string; properties: Record<string, unknown> };
		expect(readAgentProvenance(created.properties)).toEqual({
			agent: "io.x",
			conversationId: "ent_real",
			createdAt: 1000,
		});
	});

	it("update cannot inject or overwrite provenance (reserved key stripped from the patch)", async () => {
		const created = (await e.handler(
			env("io.x", "create", {
				type: "io.x/Note/v1",
				properties: { title: "N" },
				provenance: { conversationId: "ent_conv_1" },
			}),
		)) as { id: string };
		const updated = (await e.handler(
			env("io.x", "update", {
				id: created.id,
				patch: {
					title: "N2",
					[AGENT_PROVENANCE_PROPERTY_KEY]: { agent: "io.evil", conversationId: "z", createdAt: 9 },
				},
			}),
		)) as { properties: Record<string, unknown> };
		// The original server stamp survives untouched; the forged patch key is gone.
		expect(readAgentProvenance(updated.properties)).toEqual({
			agent: "io.x",
			conversationId: "ent_conv_1",
			createdAt: 1000,
		});
		expect(updated.properties.title).toBe("N2");
	});

	// ── Stage 10.1: per-entity DEK on create ────────────────────────────
	it("create writes an entity_deks row + stamps dek_id on the entity row", async () => {
		const created = (await e.handler(
			env("io.x", "create", { type: "io.x/Note/v1", properties: {} }),
		)) as { id: string };
		const dekRow = e.dekRepo.getByEntityId(created.id);
		expect(dekRow).not.toBeNull();
		expect(dekRow?.version).toBe(1);
		expect(dekRow?.sealedDek.v).toBe(1);
		// Entity row's dek_id matches the entity_deks row.
		const onEntity = e.db.prepare("SELECT dek_id FROM entities WHERE id = ?").get(created.id) as
			| { dek_id: string }
			| undefined;
		expect(onEntity?.dek_id).toBe(dekRow?.dekId);
	});

	it("the IPC response from create does NOT include dek_id or DEK material", async () => {
		const created = (await e.handler(
			env("io.x", "create", { type: "io.x/Note/v1", properties: { t: 1 } }),
		)) as Record<string, unknown>;
		expect(Object.keys(created)).not.toContain("dek_id");
		expect(Object.keys(created)).not.toContain("dekId");
		// Sanity: no field of the response carries any of the bytes the
		// sealed DEK persisted (a JSON-stringified scan is sufficient — the
		// sealed blob is base64 + structured JSON).
		const dekRow = e.dekRepo.getByEntityId(String(created.id));
		const responseStr = JSON.stringify(created);
		expect(responseStr).not.toContain(dekRow?.dekId ?? "<no-dek-row>");
		expect(responseStr).not.toContain(dekRow?.sealedDek.ciphertextB64 ?? "<no-dek-row>");
	});

	it("create invokes installEntityWrap with the freshly-minted DEK; failure rolls back the entity row", async () => {
		const installSpy: Array<{ entityId: string; dekLen: number; dekIsZeroed: boolean }> = [];
		const installer = async (entityId: string, dek: Uint8Array): Promise<void> => {
			installSpy.push({ entityId, dekLen: dek.length, dekIsZeroed: dek.every((b) => b === 0) });
		};
		const handler = makeEntitiesServiceHandler({
			getRepo: async () => e.repo,
			getLedger: async () => fakeLedger(["entities.read:*", "entities.write:*"]),
			getDekStore: async () => {
				const masterKey = generateSymmetricKey();
				return new EntityDekStore(e.dekRepo, masterKey);
			},
			newId: () => "ent_iw_ok",
			now: () => 1000,
			getVaultPath: () => "/vault",
			ydoc: async () => ({ snapshotB64: "", truncatedTail: false }),
			deliverDocUpdate: () => [],
			installEntityWrap: installer,
		});
		await handler(env("io.x", "create", { type: "io.x/N/v1", properties: {} }));
		expect(installSpy.length).toBe(1);
		expect(installSpy[0]?.entityId).toBe("ent_iw_ok");
		expect(installSpy[0]?.dekLen).toBe(32);
		expect(installSpy[0]?.dekIsZeroed).toBe(false);
	});

	it("create: installEntityWrap throwing hardDeletes the entity row", async () => {
		const handler = makeEntitiesServiceHandler({
			getRepo: async () => e.repo,
			getLedger: async () => fakeLedger(["entities.read:*", "entities.write:*"]),
			getDekStore: async () => {
				const masterKey = generateSymmetricKey();
				return new EntityDekStore(e.dekRepo, masterKey);
			},
			newId: () => "ent_iw_fail",
			now: () => 1000,
			getVaultPath: () => "/vault",
			ydoc: async () => ({ snapshotB64: "", truncatedTail: false }),
			deliverDocUpdate: () => [],
			installEntityWrap: async () => {
				throw new Error("forced wrap-install failure");
			},
		});
		await expect(
			handler(env("io.x", "create", { type: "io.x/N/v1", properties: {} })),
		).rejects.toThrow(/forced wrap-install failure/);
		expect(e.repo.get("ent_iw_fail")).toBeNull();
		expect(e.dekRepo.getByEntityId("ent_iw_fail")).toBeNull();
	});

	it("create is atomic: a failing DEK persist rolls back the entity row", async () => {
		// Mock the dek-store's persist to throw after `repo.create` has
		// already inserted the entity row. The SQLite transaction must
		// roll back both writes so no orphan entity remains.
		const handler = makeEntitiesServiceHandler({
			getRepo: async () => e.repo,
			getLedger: async () => fakeLedger(["entities.read:*", "entities.write:*"]),
			getDekStore: async () =>
				({
					nextDekId: () => "dek-broken",
					persist: () => {
						throw new Error("forced failure for atomicity test");
					},
					open: () => null,
					close: () => undefined,
				}) as unknown as EntityDekStore,
			newId: () => "ent_atomic_1",
			now: () => 1000,
			getVaultPath: () => "/vault",
			ydoc: async () => ({ snapshotB64: "", truncatedTail: false }),
			deliverDocUpdate: () => [],
		});
		await expect(
			handler(env("io.x", "create", { type: "io.x/Note/v1", properties: {} })),
		).rejects.toThrow(/forced failure/);
		// Entity row rolled back along with the (non-)wrap row.
		expect(e.repo.get("ent_atomic_1")).toBeNull();
		expect(e.dekRepo.getByEntityId("ent_atomic_1")).toBeNull();
	});

	it("hardDelete drops the entity_deks row via the explicit DELETE", async () => {
		const created = (await e.handler(
			env("io.x", "create", { type: "io.x/Note/v1", properties: {} }),
		)) as { id: string };
		expect(e.dekRepo.getByEntityId(created.id)).not.toBeNull();
		// Soft-delete first (hardDelete refuses live entities).
		await e.handler(env("io.x", "delete", { id: created.id }));
		// Soft-deleted: wrap row still present (per Bin recovery contract).
		expect(e.dekRepo.getByEntityId(created.id)).not.toBeNull();
		// Hard-delete the row (Bin "delete forever").
		expect(e.repo.hardDelete(created.id)).toBe(true);
		expect(e.dekRepo.getByEntityId(created.id)).toBeNull();
	});

	it("create preserves a caller-supplied id; a collision is Invalid", async () => {
		const made = (await e.handler(
			env("io.x", "create", { type: "io.x/N/v1", properties: {}, id: "iter-9_1" }),
		)) as { id: string };
		expect(made.id).toBe("iter-9_1");
		expect(e.repo.get("iter-9_1")).not.toBeNull();
		await expect(
			e.handler(env("io.x", "create", { type: "io.x/N/v1", properties: {}, id: "iter-9_1" })),
		).rejects.toMatchObject({ name: "Invalid" });
	});

	// 10.9b — a caller-supplied id reaches a filesystem path; a traversing /
	// malformed id must be rejected as Invalid BEFORE it can create a row,
	// mint a DEK, or drive any ydoc write outside the vault docs dir.
	it("create rejects a path-traversing / malformed caller id as Invalid, writing nothing", async () => {
		const vectors = [
			"../../../../tmp/evil",
			"foo/bar",
			"..",
			"../escape",
			"a/../../b",
			"x y",
			"with space",
			".",
			"a".repeat(129),
		];
		for (const id of vectors) {
			await expect(
				e.handler(env("io.x", "create", { type: "io.x/N/v1", properties: { p: 1 }, id })),
			).rejects.toMatchObject({ name: "Invalid" });
			// No row, no DEK, and the rejection happened before any ydoc call.
			expect(e.repo.get(id)).toBeNull();
			expect(e.dekRepo.getByEntityId(id)).toBeNull();
		}
		// The traversing ids never reached the ydoc transport (the seed write).
		expect(e.ydocCalls.length).toBe(0);

		// A normal in-charset id still succeeds end-to-end.
		const ok = (await e.handler(
			env("io.x", "create", { type: "io.x/N/v1", properties: { p: 1 }, id: "ent_ok_123" }),
		)) as { id: string };
		expect(ok.id).toBe("ent_ok_123");
		expect(e.repo.get("ent_ok_123")).not.toBeNull();
	});

	it("create is Denied without entities.write for the type", async () => {
		const ro = await setup(["entities.read:*"]);
		await expect(
			ro.handler(env("io.x", "create", { type: "io.x/Note/v1", properties: {} })),
		).rejects.toMatchObject({ name: "Denied" });
		ro.stores.close();
		await rm(ro.vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	it("get silently filters a type the app cannot read", async () => {
		const made = (await e.handler(
			env("io.x", "create", { type: "io.x/Secret/v1", properties: {} }),
		)) as { id: string };
		e.setLedger(fakeLedger(["entities.read:io.x/Other/v1"]));
		expect(await e.handler(env("io.x", "get", { id: made.id }))).toBeNull();
		e.setLedger(fakeLedger(["entities.read:io.x/Secret/v1"]));
		expect(await e.handler(env("io.x", "get", { id: made.id }))).not.toBeNull();
	});

	it("query returns only rows whose type the app can read", async () => {
		await e.handler(env("io.x", "create", { type: "io.x/A/v1", properties: {} }));
		await e.handler(env("io.x", "create", { type: "io.x/B/v1", properties: {} }));
		e.setLedger(fakeLedger(["entities.read:io.x/A/v1"]));
		const rows = (await e.handler(env("io.x", "query", { query: {} }))) as Array<{ type: string }>;
		expect(rows.map((r) => r.type)).toEqual(["io.x/A/v1"]);
	});

	it("update merges, requires write, and rejects a missing id", async () => {
		const made = (await e.handler(
			env("io.x", "create", { type: "io.x/N/v1", properties: { a: 1 } }),
		)) as { id: string };
		const upd = (await e.handler(env("io.x", "update", { id: made.id, patch: { b: 2 } }))) as {
			properties: unknown;
		};
		expect(upd.properties).toEqual({ a: 1, b: 2 });
		await expect(e.handler(env("io.x", "update", { id: "nope", patch: {} }))).rejects.toMatchObject({
			name: "Invalid",
		});
		e.setLedger(fakeLedger(["entities.read:*"]));
		await expect(
			e.handler(env("io.x", "update", { id: made.id, patch: { c: 3 } })),
		).rejects.toMatchObject({ name: "Denied" });
	});

	it("delete is idempotent, write-gated, and soft-deletes", async () => {
		expect(await e.handler(env("io.x", "delete", { id: "ghost" }))).toBeNull();
		const made = (await e.handler(env("io.x", "create", { type: "io.x/N/v1", properties: {} }))) as {
			id: string;
		};
		const ro = fakeLedger(["entities.read:*"]);
		e.setLedger(ro);
		await expect(e.handler(env("io.x", "delete", { id: made.id }))).rejects.toMatchObject({
			name: "Denied",
		});
		e.setLedger(fakeLedger(["entities.read:*", "entities.write:*"]));
		expect(await e.handler(env("io.x", "delete", { id: made.id }))).toBeNull();
		expect(e.repo.get(made.id)).toBeNull();
	});

	it("unknown method → Invalid", async () => {
		await expect(e.handler(env("io.x", "frobnicate", {}))).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("loadDoc reads the entity's Y.Doc once the type is readable", async () => {
		const made = (await e.handler(
			env("io.x", "create", { type: "io.x/Note/v1", properties: {} }),
		)) as { id: string };
		const out = (await e.handler(env("io.x", "loadDoc", { id: made.id }))) as {
			snapshotB64: string;
		};
		expect(out.snapshotB64).toBe("AQID");
		expect(e.ydocCalls).toContainEqual({
			method: "load",
			entityId: made.id,
			updateB64: undefined,
		});
		await expect(e.handler(env("io.x", "loadDoc", { id: "ghost" }))).rejects.toMatchObject({
			name: "Invalid",
		});
		e.setLedger(fakeLedger([])); // no read cap
		await expect(e.handler(env("io.x", "loadDoc", { id: made.id }))).rejects.toMatchObject({
			name: "Denied",
		});
	});

	// 12.8 (doc 28 "Corrupted Yjs file") — a recovered-but-truncated tail fires
	// onTruncatedTail so the shell warns the user; a clean load does not.
	it("loadDoc warns via onTruncatedTail when the worker recovered a truncated tail", async () => {
		const made = (await e.handler(
			env("io.x", "create", { type: "io.x/Note/v1", properties: {} }),
		)) as { id: string };

		await e.handler(env("io.x", "loadDoc", { id: made.id }));
		expect(e.truncatedCalls).toEqual([]);

		e.setLoadTruncated(true);
		await e.handler(env("io.x", "loadDoc", { id: made.id }));
		expect(e.truncatedCalls).toEqual([made.id]);
	});

	it("loadDoc does not warn when the read gate rejects (no truncation leak before authz)", async () => {
		const made = (await e.handler(
			env("io.x", "create", { type: "io.x/Note/v1", properties: {} }),
		)) as { id: string };
		e.setLoadTruncated(true);
		e.setLedger(fakeLedger([])); // no read cap — load never runs
		await expect(e.handler(env("io.x", "loadDoc", { id: made.id }))).rejects.toMatchObject({
			name: "Denied",
		});
		expect(e.truncatedCalls).toEqual([]);
	});

	it("applyDoc requires write; closeDoc is idempotent + ungated", async () => {
		const made = (await e.handler(env("io.x", "create", { type: "io.x/N/v1", properties: {} }))) as {
			id: string;
		};
		await e.handler(env("io.x", "applyDoc", { id: made.id, updateB64: "BB==" }));
		expect(e.ydocCalls).toContainEqual({
			method: "applyUpdate",
			entityId: made.id,
			updateB64: "BB==",
		});
		e.setLedger(fakeLedger(["entities.read:*"]));
		await expect(
			e.handler(env("io.x", "applyDoc", { id: made.id, updateB64: "CC==" })),
		).rejects.toMatchObject({ name: "Denied" });
		// closeDoc: no cap, missing entity is a no-op, still proxies the worker.
		expect(await e.handler(env("io.x", "closeDoc", { id: made.id }))).toBeNull();
		expect(e.ydocCalls.at(-1)).toEqual({
			method: "close",
			entityId: made.id,
			updateB64: undefined,
		});
	});

	it("doc transport → Unavailable when not wired", async () => {
		const handler = makeEntitiesServiceHandler({
			getRepo: async () => e.repo,
			getLedger: async () => fakeLedger(["entities.read:*", "entities.write:*"]),
			getDekStore: async () => new EntityDekStore(e.dekRepo, generateSymmetricKey()),
			newId: () => "ent_x",
		});
		const made = e.repo.create({
			id: "ent_nodoc",
			type: "io.x/N/v1",
			properties: {},
			createdBy: "io.x",
			now: 1,
			dekId: null,
		});
		await expect(handler(env("io.x", "loadDoc", { id: made.id }))).rejects.toMatchObject({
			name: "Unavailable",
		});
	});

	it("no active vault (null repo/ledger) → Unavailable, fail closed", async () => {
		const handler = makeEntitiesServiceHandler({
			getRepo: async () => null,
			getLedger: async () => null,
			getDekStore: async () => null,
			newId: () => "ent_x",
		});
		await expect(handler(env("io.x", "get", { id: "a" }))).rejects.toMatchObject({
			name: "Unavailable",
		});
	});

	it("a ledger that throws LedgerUnavailableError fails closed as Unavailable", async () => {
		e.setLedger({
			has() {
				throw new LedgerUnavailableError(new Error("locked"));
			},
		} as unknown as CapabilityLedger);
		const made = e.repo.create({
			id: "ent_z",
			type: "io.x/N/v1",
			properties: {},
			createdBy: "io.x",
			now: 1,
			dekId: null,
		});
		await expect(e.handler(env("io.x", "get", { id: made.id }))).rejects.toMatchObject({
			name: "Unavailable",
		});
	});

	// ── 9.3.2c: live cross-window fan-out ──────────────────────────────
	it("applyDoc fans the delta to other subscriber apps, excluding the originator", async () => {
		const made = (await e.handler(
			env("io.x", "create", { type: "io.x/Note/v1", properties: {} }),
		)) as { id: string };
		// Two apps open the doc; both passed the read gate at loadDoc.
		await e.handler(env("io.x", "loadDoc", { id: made.id }));
		await e.handler(env("io.y", "loadDoc", { id: made.id }));

		await e.handler(env("io.x", "applyDoc", { id: made.id, updateB64: "BB==" }));

		expect(e.deliverCalls).toEqual([{ entityId: made.id, updateB64: "BB==", targets: ["io.y"] }]);
	});

	it("does not fan when the originator is the only subscriber", async () => {
		const made = (await e.handler(env("io.x", "create", { type: "io.x/N/v1", properties: {} }))) as {
			id: string;
		};
		await e.handler(env("io.x", "loadDoc", { id: made.id }));
		await e.handler(env("io.x", "applyDoc", { id: made.id, updateB64: "BB==" }));
		expect(e.deliverCalls).toHaveLength(0);
	});

	it("closeDoc unsubscribes (refcounted) so a later applyDoc no longer targets it", async () => {
		const made = (await e.handler(env("io.x", "create", { type: "io.x/N/v1", properties: {} }))) as {
			id: string;
		};
		await e.handler(env("io.x", "loadDoc", { id: made.id }));
		// io.y opens twice (two intra-app windows, one renderer): refcount 2.
		await e.handler(env("io.y", "loadDoc", { id: made.id }));
		await e.handler(env("io.y", "loadDoc", { id: made.id }));

		await e.handler(env("io.y", "closeDoc", { id: made.id })); // refcount 2 → 1
		await e.handler(env("io.x", "applyDoc", { id: made.id, updateB64: "B1" }));
		expect(e.deliverCalls.at(-1)).toEqual({
			entityId: made.id,
			updateB64: "B1",
			targets: ["io.y"], // still subscribed
		});

		await e.handler(env("io.y", "closeDoc", { id: made.id })); // refcount 1 → 0
		await e.handler(env("io.x", "applyDoc", { id: made.id, updateB64: "B2" }));
		expect(e.deliverCalls).toHaveLength(1); // no new fan-out — io.y gone
	});

	// 9.3.2d — a renderer that died without closeDoc would leak its
	// refcount forever; applyDoc prunes the apps deliverDocUpdate reports
	// as having no live window.
	it("applyDoc prunes a subscriber whose renderer died without closeDoc", async () => {
		const made = (await e.handler(env("io.x", "create", { type: "io.x/N/v1", properties: {} }))) as {
			id: string;
		};
		await e.handler(env("io.x", "loadDoc", { id: made.id }));
		await e.handler(env("io.y", "loadDoc", { id: made.id }));

		// io.y's renderer crashed; the next fan-out reports it dead.
		e.setDeadApps(["io.y"]);
		await e.handler(env("io.x", "applyDoc", { id: made.id, updateB64: "B1" }));
		expect(e.deliverCalls.at(-1)).toEqual({ entityId: made.id, updateB64: "B1", targets: ["io.y"] });

		// Pruned: a later applyDoc no longer targets the dead app even
		// though io.y never called closeDoc.
		e.setDeadApps([]);
		await e.handler(env("io.x", "applyDoc", { id: made.id, updateB64: "B2" }));
		expect(e.deliverCalls).toHaveLength(1);
	});

	it("switching the active vault clears docSubscribers (no cross-vault fan-out)", async () => {
		const made = (await e.handler(env("io.x", "create", { type: "io.x/N/v1", properties: {} }))) as {
			id: string;
		};
		await e.handler(env("io.x", "loadDoc", { id: made.id }));
		await e.handler(env("io.y", "loadDoc", { id: made.id }));

		// A vault switch orphans every subKey (the old vaultPath can never
		// match again); the map is dropped on the next envelope.
		e.setVaultPath("/other-vault");
		await e.handler(env("io.x", "applyDoc", { id: made.id, updateB64: "B1" }));
		expect(e.deliverCalls).toHaveLength(0);
	});

	it("closing the vault (null path) clears docSubscribers", async () => {
		const made = (await e.handler(env("io.x", "create", { type: "io.x/N/v1", properties: {} }))) as {
			id: string;
		};
		await e.handler(env("io.x", "loadDoc", { id: made.id }));
		await e.handler(env("io.y", "loadDoc", { id: made.id }));

		e.setVaultPath(null);
		// applyDoc now Unavailable (no vault), but the clear already ran at
		// envelope entry — re-opening the same vault starts from empty.
		await expect(
			e.handler(env("io.x", "applyDoc", { id: made.id, updateB64: "B1" })),
		).rejects.toMatchObject({ name: "Unavailable" });
		e.setVaultPath("/vault");
		await e.handler(env("io.x", "applyDoc", { id: made.id, updateB64: "B2" }));
		expect(e.deliverCalls).toHaveLength(0); // io.y's pre-close sub was dropped
	});
});

// ── Y.Doc → entities.db projection (Phase 1 keystone) ──────────────────
// applyDoc must materialise the just-applied canonical doc state into the
// `entities.db` row, so the Y.Doc is the source of truth and the SQLite
// row is a derived index.
describe("entities service — Y.Doc → entities.db projection", () => {
	// A faithful `ydoc` fake: keeps a real Y.Doc per entity, applies the
	// incoming update, and returns the codec's projection exactly as the
	// real worker does.
	async function setupWithRealDoc() {
		const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-ent-proj-"));
		const stores = new DataStores(vaultDir);
		const db = await stores.open("entities");
		const repo = new EntitiesRepository(db);
		const dekStore = new EntityDekStore(new EntityDeksRepository(db), generateSymmetricKey());
		const liveDocs = new Map<string, Y.Doc>();
		const docFor = (id: string): Y.Doc => {
			let doc = liveDocs.get(id);
			if (!doc) {
				doc = new Y.Doc();
				liveDocs.set(id, doc);
			}
			return doc;
		};
		const handler = makeEntitiesServiceHandler({
			getRepo: async () => repo,
			getLedger: async () => fakeLedger(["entities.read:*", "entities.write:*"]),
			getDekStore: async () => dekStore,
			newId: () => `ent_${++ids}`,
			now: () => 2000,
			getVaultPath: () => "/vault",
			ydoc: async (method, a) => {
				const doc = docFor(a.entityId);
				if (method === "applyUpdate") {
					Y.applyUpdate(doc, base64ToBytes(a.updateB64 ?? ""));
					return {
						compacted: false,
						sizeBytes: 1,
						projection: readEntityDocProjection(doc),
					};
				}
				if (method === "setEntityState") {
					doc.transact(() => {
						if (a.seedProps && doc.getMap(ENTITY_PROPS_MAP_NAME).size === 0) {
							writeEntityProps(doc, a.seedProps);
						}
						if (a.props) writeEntityProps(doc, a.props);
						if (a.links) writeEntityLinks(doc, a.links);
					});
					return { projection: readEntityDocProjection(doc) };
				}
				if (method === "load") {
					return { snapshotB64: bytesToBase64(Y.encodeStateAsUpdate(doc)), truncatedTail: false };
				}
				return { closed: true };
			},
		});
		return { vaultDir, stores, repo, handler, docFor };
	}

	let h: Awaited<ReturnType<typeof setupWithRealDoc>>;
	beforeEach(async () => {
		h = await setupWithRealDoc();
	});
	afterEach(async () => {
		h.stores.close();
		await rm(h.vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	// An editor edits the entity's CURRENT doc state, then ships the diff —
	// so the update must be built on a replica forked from the live doc, not
	// a disconnected fresh doc (which would be a concurrent CRDT branch that
	// merges nondeterministically with create's seeded properties).
	function editLiveDoc(entityId: string, props: Record<string, unknown>): string {
		const replica = new Y.Doc();
		Y.applyUpdate(replica, Y.encodeStateAsUpdate(h.docFor(entityId)));
		const before = Y.encodeStateVector(replica);
		writeEntityProps(replica, props);
		return bytesToBase64(Y.encodeStateAsUpdate(replica, before));
	}

	it("materialises property edits made through the Y.Doc into the row", async () => {
		const made = (await h.handler(
			env("io.x", "create", { type: "io.x/Task/v1", properties: { title: "seed" } }),
		)) as { id: string };

		await h.handler(
			env("io.x", "applyDoc", {
				id: made.id,
				updateB64: editLiveDoc(made.id, { title: "edited via doc", statusKey: "done" }),
			}),
		);

		const row = h.repo.get(made.id);
		expect(row?.properties).toMatchObject({ title: "edited via doc", statusKey: "done" });
	});

	it("materialises a link added through the Y.Doc into the links table", async () => {
		const made = (await h.handler(
			env("io.x", "create", { type: "io.x/Task/v1", properties: {} }),
		)) as { id: string };
		const project = (await h.handler(
			env("io.x", "create", { type: "io.x/Project/v1", properties: {} }),
		)) as { id: string };

		const scratch = new Y.Doc();
		writeEntityLinks(scratch, [
			{ id: `lnk_${made.id}`, destEntityId: project.id, linkType: "in-project", createdAt: 5 },
		]);
		await h.handler(
			env("io.x", "applyDoc", {
				id: made.id,
				updateB64: bytesToBase64(Y.encodeStateAsUpdate(scratch)),
			}),
		);

		expect(h.repo.linksFrom(made.id)).toEqual([
			{
				id: `lnk_${made.id}`,
				sourceEntityId: made.id,
				destEntityId: project.id,
				linkType: "in-project",
				createdAt: 5,
			},
		]);
	});

	it("a body-only edit (no property root) never clobbers the row", async () => {
		const made = (await h.handler(
			env("io.x", "create", { type: "io.x/Note/v1", properties: { title: "keep me" } }),
		)) as { id: string };

		// An update that touches only the universal body root.
		const scratch = new Y.Doc();
		scratch.get(UNIVERSAL_BODY_FRAGMENT_NAME, Y.XmlText).insert(0, "body text");
		await h.handler(
			env("io.x", "applyDoc", {
				id: made.id,
				updateB64: bytesToBase64(Y.encodeStateAsUpdate(scratch)),
			}),
		);

		expect(h.repo.get(made.id)?.properties).toEqual({ title: "keep me" });
	});

	it("does not leak the internal projection field back over IPC", async () => {
		const made = (await h.handler(
			env("io.x", "create", { type: "io.x/Task/v1", properties: {} }),
		)) as { id: string };
		const reply = (await h.handler(
			env("io.x", "applyDoc", { id: made.id, updateB64: editLiveDoc(made.id, { title: "x" }) }),
		)) as Record<string, unknown>;
		expect(reply).not.toHaveProperty("projection");
		expect(reply).toMatchObject({ compacted: false });
	});

	// ── Phase 2: create/update routed through the canonical Y.Doc ──────────
	it("create seeds the entity's Y.Doc with its properties (doc is source of truth)", async () => {
		const made = (await h.handler(
			env("io.x", "create", { type: "io.x/Task/v1", properties: { title: "born", priority: 1 } }),
		)) as { id: string };
		// The canonical doc — not just the row — carries the properties.
		expect(readEntityDocProjection(h.docFor(made.id)).properties).toEqual({
			title: "born",
			priority: 1,
		});
	});

	it("update writes through the Y.Doc then materialises the projection into the row", async () => {
		const made = (await h.handler(
			env("io.x", "create", {
				type: "io.x/Task/v1",
				properties: { title: "born", statusKey: "todo" },
			}),
		)) as { id: string };

		await h.handler(env("io.x", "update", { id: made.id, patch: { statusKey: "done" } }));

		// The canonical doc carries the merged state (source of truth)…
		expect(readEntityDocProjection(h.docFor(made.id)).properties).toEqual({
			title: "born",
			statusKey: "done",
		});
		// …and the row is the projection of it.
		expect(h.repo.get(made.id)?.properties).toMatchObject({ title: "born", statusKey: "done" });
	});

	// Phase 5 lazy hydration: an entity whose row was populated directly
	// (seeder / legacy backfill) has an EMPTY Y.Doc. The first update must
	// hydrate the doc with the row's FULL property set before the patch, so
	// the doc — the future sync source of truth — carries the whole object.
	it("update lazily hydrates an empty Y.Doc from the row's full properties", async () => {
		// Simulate a seeded/backfilled row: created straight in the repo, no
		// Y.Doc write (bypasses the service create path that would seed it).
		h.repo.create({
			id: "seeded-1",
			type: "brainstorm/Task/v1",
			properties: { title: "Seeded task", statusKey: "todo", priority: 3 },
			createdBy: "io.seed",
			now: 1,
			dekId: null,
		});
		// Sanity: the Y.Doc is empty before any update.
		expect(readEntityDocProjection(h.docFor("seeded-1")).properties).toBeUndefined();

		await h.handler(env("io.x", "update", { id: "seeded-1", patch: { statusKey: "done" } }));

		// The Y.Doc now carries the FULL set (seeded), with the patch applied —
		// not just the single edited field.
		expect(readEntityDocProjection(h.docFor("seeded-1")).properties).toEqual({
			title: "Seeded task",
			statusKey: "done",
			priority: 3,
		});
	});
});

// ── Stage 10.12: always-on live-sync hooks ─────────────────────────────────
describe("entities service — live-sync hooks (10.12)", () => {
	let e: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		e = await setup();
	});
	afterEach(async () => {
		e.stores.close();
		await rm(e.vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	it("loadDoc fires onDocOpened with the entity id + type", async () => {
		const created = (await e.handler(
			env("io.x", "create", { type: "io.x/Note/v1", properties: { t: 1 } }),
		)) as { id: string };
		await e.handler(env("io.x", "loadDoc", { id: created.id }));
		expect(e.docOpenedCalls).toEqual([{ entityId: created.id, type: "io.x/Note/v1" }]);
	});

	it("applyDoc fires onLocalDocUpdate with the exact persisted update bytes", async () => {
		const created = (await e.handler(
			env("io.x", "create", { type: "io.x/Note/v1", properties: {} }),
		)) as { id: string };
		const update = bytesToBase64(new Uint8Array([7, 8, 9]));
		await e.handler(env("io.x", "applyDoc", { id: created.id, updateB64: update }));
		expect(e.localUpdateCalls).toHaveLength(1);
		const call = e.localUpdateCalls[0];
		expect(call?.entityId).toBe(created.id);
		expect(call?.type).toBe("io.x/Note/v1");
		expect(call?.update).toEqual(new Uint8Array([7, 8, 9]));
	});

	it("a property update fires onLocalDocUpdate from the worker-returned bytes", async () => {
		const created = (await e.handler(
			env("io.x", "create", { type: "io.x/Note/v1", properties: { t: 1 } }),
		)) as { id: string };
		e.localUpdateCalls.length = 0; // ignore the create-time seed emit
		await e.handler(env("io.x", "update", { id: created.id, patch: { t: 2 } }));
		// The fake worker returns updateB64 "AQID" (== [1,2,3]) for setEntityState.
		expect(e.localUpdateCalls).toHaveLength(1);
		expect(e.localUpdateCalls[0]?.update).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("applyDoc fires onDocCompacted only when the worker reports a compaction (10.14)", async () => {
		const created = (await e.handler(
			env("io.x", "create", { type: "io.x/Note/v1", properties: {} }),
		)) as { id: string };
		// Default: worker returns compacted=false → no compaction hook.
		await e.handler(env("io.x", "applyDoc", { id: created.id, updateB64: "AQID" }));
		expect(e.docCompactedCalls).toHaveLength(0);
		// Worker now reports a compaction → the hook fires with id + type.
		e.setCompactNext(true);
		await e.handler(env("io.x", "applyDoc", { id: created.id, updateB64: "AQID" }));
		expect(e.docCompactedCalls).toEqual([{ entityId: created.id, type: "io.x/Note/v1" }]);
	});

	it("a denied applyDoc never fires the local-update hook", async () => {
		const created = (await e.handler(
			env("io.x", "create", { type: "io.x/Note/v1", properties: {} }),
		)) as { id: string };
		e.setLedger(fakeLedger(["entities.read:*"])); // read but not write
		await expect(
			e.handler(env("io.x", "applyDoc", { id: created.id, updateB64: "AQID" })),
		).rejects.toThrow(/no entities.write/);
		expect(e.localUpdateCalls).toHaveLength(0);
	});

	it("the bound applyRemoteDoc applies + materialises + delivers WITHOUT firing the emit hook", async () => {
		const created = (await e.handler(
			env("io.x", "create", { type: "io.x/Note/v1", properties: {} }),
		)) as { id: string };
		// Two apps hold the doc open — both are peers of a remote edit (no
		// originator to exclude).
		await e.handler(env("io.a", "loadDoc", { id: created.id }));
		await e.handler(env("io.b", "loadDoc", { id: created.id }));
		e.localUpdateCalls.length = 0;

		const applyRemoteDoc = e.getApplyRemoteDoc();
		expect(applyRemoteDoc).toBeTypeOf("function");
		await applyRemoteDoc?.(created.id, "AQID");

		// Routed into the worker as an applyUpdate.
		expect(e.ydocCalls.some((c) => c.method === "applyUpdate" && c.entityId === created.id)).toBe(
			true,
		);
		// Delivered to BOTH open apps (remote edit excludes nobody).
		const deliver = e.deliverCalls.find((c) => c.entityId === created.id);
		expect(deliver?.targets.slice().sort()).toEqual(["io.a", "io.b"]);
		// Crucially: NO echo — a remote apply must not re-enter the emit hook.
		expect(e.localUpdateCalls).toHaveLength(0);
	});

	// ── Asset-B4: implicit asset-ref bind writer ────────────────────────
	const assetUrl = (id: string) => `brainstorm://asset/${id}`;

	it("create with an asset URL binds an asset_ref with the kind-derived role", async () => {
		e.seedAsset("fav1", AssetKind.Favicon);
		const created = (await e.handler(
			env("io.x", "create", {
				type: "io.x/Bookmark/v1",
				properties: { faviconUrl: assetUrl("fav1") },
			}),
		)) as { id: string };
		const refs = e.repo.assetRefs.listByEntity(created.id);
		expect(refs).toHaveLength(1);
		expect(refs[0]?.assetId).toBe("fav1");
		expect(refs[0]?.role).toBe(AssetRefRole.Favicon);
	});

	it("update that drops the asset URL prunes the ref", async () => {
		e.seedAsset("fav1", AssetKind.Favicon);
		const created = (await e.handler(
			env("io.x", "create", {
				type: "io.x/Bookmark/v1",
				properties: { faviconUrl: assetUrl("fav1") },
			}),
		)) as { id: string };
		expect(e.repo.assetRefs.listByEntity(created.id)).toHaveLength(1);

		await e.handler(env("io.x", "update", { id: created.id, patch: { faviconUrl: "" } }));
		expect(e.repo.assetRefs.listByEntity(created.id)).toHaveLength(0);
	});

	it("update adding a second asset binds both refs", async () => {
		e.seedAsset("fav1", AssetKind.Favicon);
		e.seedAsset("cov1", AssetKind.Cover);
		const created = (await e.handler(
			env("io.x", "create", {
				type: "io.x/Bookmark/v1",
				properties: { faviconUrl: assetUrl("fav1") },
			}),
		)) as { id: string };

		await e.handler(env("io.x", "update", { id: created.id, patch: { coverUrl: assetUrl("cov1") } }));
		const refs = e.repo.assetRefs.listByEntity(created.id);
		expect(refs.map((r) => r.assetId).sort()).toEqual(["cov1", "fav1"]);
		expect(refs.find((r) => r.assetId === "cov1")?.role).toBe(AssetRefRole.Cover);
	});

	it("a dangling (non-local) asset URL binds no ref", async () => {
		const created = (await e.handler(
			env("io.x", "create", {
				type: "io.x/Bookmark/v1",
				properties: { faviconUrl: assetUrl("not-stored") },
			}),
		)) as { id: string };
		expect(e.repo.assetRefs.listByEntity(created.id)).toHaveLength(0);
	});

	it("delete removes the entity's refs (soft delete → no FK cascade)", async () => {
		e.seedAsset("fav1", AssetKind.Favicon);
		const created = (await e.handler(
			env("io.x", "create", {
				type: "io.x/Bookmark/v1",
				properties: { faviconUrl: assetUrl("fav1") },
			}),
		)) as { id: string };
		expect(e.repo.assetRefs.listByEntity(created.id)).toHaveLength(1);

		await e.handler(env("io.x", "delete", { id: created.id }));
		expect(e.repo.assetRefs.listByEntity(created.id)).toHaveLength(0);
	});

	it("a reconcile throw does not fail the entity write", async () => {
		e.seedAsset("fav1", AssetKind.Favicon);
		e.setAssetKindThrows(true);
		const created = (await e.handler(
			env("io.x", "create", {
				type: "io.x/Bookmark/v1",
				properties: { faviconUrl: assetUrl("fav1") },
			}),
		)) as { id: string };
		// Write committed despite the reconcile failure; no ref bound.
		expect(e.repo.get(created.id)).not.toBeNull();
		expect(e.repo.assetRefs.listByEntity(created.id)).toHaveLength(0);
	});

	it("onAssetBound fires once per NEWLY created ref, on create and update", async () => {
		e.seedAsset("fav1", AssetKind.Favicon);
		e.seedAsset("cov1", AssetKind.Cover);
		const created = (await e.handler(
			env("io.x", "create", {
				type: "io.x/Bookmark/v1",
				properties: { faviconUrl: assetUrl("fav1") },
			}),
		)) as { id: string };
		expect(e.assetBoundCalls).toEqual([{ entityId: created.id, assetId: "fav1" }]);

		await e.handler(env("io.x", "update", { id: created.id, patch: { coverUrl: assetUrl("cov1") } }));
		// Only the NEW ref fires — the pre-existing fav1 ref must not re-trigger.
		expect(e.assetBoundCalls).toEqual([
			{ entityId: created.id, assetId: "fav1" },
			{ entityId: created.id, assetId: "cov1" },
		]);
	});

	it("onAssetBound does not fire for an unchanged ref, a dangling URL, or a prune", async () => {
		e.seedAsset("fav1", AssetKind.Favicon);
		const created = (await e.handler(
			env("io.x", "create", {
				type: "io.x/Bookmark/v1",
				properties: { faviconUrl: assetUrl("fav1") },
			}),
		)) as { id: string };
		e.assetBoundCalls.length = 0;

		// No-op property update — ref unchanged, no re-fire.
		await e.handler(env("io.x", "update", { id: created.id, patch: { title: "t" } }));
		// Dangling URL — never bound, never fired.
		await e.handler(env("io.x", "update", { id: created.id, patch: { extraUrl: assetUrl("nope") } }));
		// Prune — dropping the URL removes the ref, no fire.
		await e.handler(env("io.x", "update", { id: created.id, patch: { faviconUrl: "" } }));
		expect(e.assetBoundCalls).toHaveLength(0);
	});

	it("a throwing onAssetBound hook is contained — refs still land, write still succeeds", async () => {
		e.seedAsset("fav1", AssetKind.Favicon);
		e.seedAsset("cov1", AssetKind.Cover);
		e.setAssetBoundThrows(true);
		const created = (await e.handler(
			env("io.x", "create", {
				type: "io.x/Bookmark/v1",
				properties: { faviconUrl: assetUrl("fav1"), coverUrl: assetUrl("cov1") },
			}),
		)) as { id: string };
		// Both refs written despite the hook throwing on each.
		const refs = e.repo.assetRefs.listByEntity(created.id);
		expect(refs.map((r) => r.assetId).sort()).toEqual(["cov1", "fav1"]);
	});
});

// ── F-158: entities.merge ───────────────────────────────────────────────────
describe("entities.merge (F-158 duplicate merge)", () => {
	const PERSON = "brainstorm/Person/v1";
	const TASK = "io.x/Task/v1";

	let e: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		e = await setup();
	});
	afterEach(async () => {
		e.stores.close();
		await rm(e.vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	type MergeResult = {
		survivorId: string;
		mergedIds: string[];
		linksRepointed: number;
		refsRewritten: number;
	};

	async function createEntity(type: string, properties: Record<string, unknown>): Promise<string> {
		const created = (await e.handler(env("io.x", "create", { type, properties }))) as {
			id: string;
		};
		return created.id;
	}

	async function merge(
		survivorId: string,
		loserIds: string[],
		patch?: Record<string, unknown>,
	): Promise<MergeResult> {
		return (await e.handler(
			env("io.x", "merge", patch ? { survivorId, loserIds, patch } : { survivorId, loserIds }),
		)) as MergeResult;
	}

	it("applies the survivor patch, soft-deletes losers into the Bin, and reports them", async () => {
		const survivor = await createEntity(PERSON, { name: "Dana Whitfield" });
		const loser = await createEntity(PERSON, {
			name: "Dana Whitfield",
			email: ["dana@x.com"],
		});
		const result = await merge(survivor, [loser], { email: ["dana@x.com"] });

		expect(result).toEqual({
			survivorId: survivor,
			mergedIds: [loser],
			linksRepointed: 0,
			refsRewritten: 0,
		});
		expect(e.repo.get(survivor)?.properties).toMatchObject({ email: ["dana@x.com"] });
		// The loser is gone from the live set but recoverable from the Bin.
		expect(e.repo.get(loser)).toBeNull();
		expect(e.repo.listDeleted().map((r) => r.id)).toContain(loser);
		expect(e.repo.restore(loser, 2000)).toBe(true);
		expect(e.repo.get(loser)).not.toBeNull();
	});

	it("repoints stored links from losers to the survivor, collapsing self-loops + duplicates", async () => {
		const survivor = await createEntity(PERSON, { name: "Dana" });
		const loser = await createEntity(PERSON, { name: "Dana W." });
		const task = await createEntity(TASK, { title: "Prep" });
		// task → loser (moves), loser → task (moves), survivor → loser
		// (would self-loop after repoint → collapsed), task → survivor
		// (pre-existing duplicate of the repointed task → loser).
		e.repo.putLink({
			id: "l1",
			sourceEntityId: task,
			destEntityId: loser,
			linkType: "t/assn",
			createdAt: 1,
		});
		e.repo.putLink({
			id: "l2",
			sourceEntityId: loser,
			destEntityId: task,
			linkType: "p/owns",
			createdAt: 1,
		});
		e.repo.putLink({
			id: "l3",
			sourceEntityId: survivor,
			destEntityId: loser,
			linkType: "p/knows",
			createdAt: 1,
		});
		e.repo.putLink({
			id: "l4",
			sourceEntityId: task,
			destEntityId: survivor,
			linkType: "t/assn",
			createdAt: 1,
		});

		const result = await merge(survivor, [loser]);
		expect(result.linksRepointed).toBe(3);

		const fromTask = e.repo.linksFrom(task);
		// l1 collapsed as a duplicate of l4 — exactly one task → survivor link.
		expect(fromTask.filter((l) => l.destEntityId === survivor)).toHaveLength(1);
		expect(fromTask.some((l) => l.destEntityId === loser)).toBe(false);
		// l2 moved: survivor → task.
		expect(e.repo.linksFrom(survivor).map((l) => l.destEntityId)).toEqual([task]);
		// l3 (survivor → loser) would self-loop — collapsed, not moved.
		expect(e.repo.linksFrom(survivor).some((l) => l.destEntityId === survivor)).toBe(false);
	});

	it("rewrites property refs in referrers of OTHER types (scalar, array, envelope)", async () => {
		const survivor = await createEntity(PERSON, { name: "Dana" });
		const loserA = await createEntity(PERSON, { name: "Dana W" });
		const loserB = await createEntity(PERSON, { name: "D. Whitfield" });
		const task = await createEntity(TASK, { title: "Prep", assignee: loserA });
		const note = await createEntity("io.x/Note/v1", {
			title: "Minutes",
			people: [loserA, loserB, survivor],
			author: { value: loserB, label: "D. Whitfield" },
		});

		const result = await merge(survivor, [loserA, loserB]);
		expect(result.refsRewritten).toBe(2);
		expect(e.repo.get(task)?.properties).toMatchObject({ assignee: survivor });
		expect(e.repo.get(note)?.properties).toMatchObject({
			// Both losers collapse onto the already-present survivor.
			people: [survivor],
			author: { value: survivor, label: "D. Whitfield" },
		});
	});

	it("drops a would-be self-ref when the survivor's own properties list a loser", async () => {
		const survivor = await createEntity(PERSON, { name: "Dana" });
		const other = await createEntity(PERSON, { name: "Sam" });
		const loser = await createEntity(PERSON, { name: "Dana W" });
		await e.handler(env("io.x", "update", { id: survivor, patch: { links: [loser, other] } }));

		await merge(survivor, [loser]);
		expect(e.repo.get(survivor)?.properties).toMatchObject({ links: [other] });
	});

	it("is idempotent — re-merging already-binned losers is a no-op", async () => {
		const survivor = await createEntity(PERSON, { name: "Dana" });
		const loser = await createEntity(PERSON, { name: "Dana W" });
		const task = await createEntity(TASK, { title: "Prep", assignee: loser });

		const first = await merge(survivor, [loser]);
		expect(first.mergedIds).toEqual([loser]);
		expect(first.refsRewritten).toBe(1);

		const second = await merge(survivor, [loser]);
		expect(second).toEqual({
			survivorId: survivor,
			mergedIds: [],
			linksRepointed: 0,
			refsRewritten: 0,
		});
		expect(e.repo.get(task)?.properties).toMatchObject({ assignee: survivor });
		expect(e.repo.get(loser)).toBeNull();
	});

	it("denies without entities.write on the merged type", async () => {
		const survivor = await createEntity(PERSON, { name: "Dana" });
		const loser = await createEntity(PERSON, { name: "Dana W" });
		e.setLedger(fakeLedger(["entities.read:*"]));
		await expect(merge(survivor, [loser])).rejects.toMatchObject({ name: "Denied" });
		expect(e.repo.get(loser)).not.toBeNull();
	});

	it("rejects a loser of a different type (Invalid), leaving everything live", async () => {
		const survivor = await createEntity(PERSON, { name: "Dana" });
		const task = await createEntity(TASK, { title: "Prep" });
		await expect(merge(survivor, [task])).rejects.toMatchObject({ name: "Invalid" });
		expect(e.repo.get(task)).not.toBeNull();
	});

	it("rejects a missing survivor and an empty loser list", async () => {
		const survivor = await createEntity(PERSON, { name: "Dana" });
		await expect(merge("ent_nope", [survivor])).rejects.toMatchObject({ name: "Invalid" });
		await expect(merge(survivor, [])).rejects.toMatchObject({ name: "Invalid" });
		// The survivor itself in the loser list never counts as a loser.
		await expect(merge(survivor, [survivor])).rejects.toMatchObject({ name: "Invalid" });
	});
});
