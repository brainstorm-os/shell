/**
 * Stage 10.3d(a) — the roster read must not leak the doc it reads.
 *
 * `resolveSiblingRoster` opens a `VaultPropertiesStore`, which is a full
 * `YDocStore.load`: a file read and a BRAND-NEW `Y.Doc` with an `update`
 * observer wired to persist through the store. It never closed either, and the
 * ongoing per-entity producer calls it once PER ENTITY WRITE — so every write
 * left behind a whole doc and a live listener, paid even for entities the
 * fan-out then refused at version 0.
 *
 * The leak is invisible to a functional test: the roster it returns is correct
 * every time. So these assert the LIFETIME, not the value — that the doc is
 * closed, that repeat reads share one load, and that the cache which makes that
 * possible cannot go stale across a pairing.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { signAddDeviceRecord } from "../pairing/devices-store";
import { LoopbackRelayPort, type RelayPort } from "../sync/relay-port";
import { VaultSession } from "../vault/session";
import { VaultPropertiesStore } from "../vault/vault-properties-store";
import { type CollabRelayLike, SharingEngine } from "./sharing-engine";

function relayAdapter(port: LoopbackRelayPort): CollabRelayLike {
	return {
		currentPort: (): RelayPort => port,
		onFrame: (cb) => port.onFrame(cb),
		offFrame: (cb) => port.offFrame(cb),
	};
}

/** How many `update` listeners are live on a Y.Doc. `close()` removes the one
 *  `VaultPropertiesStore.open` wires; Yjs drops the whole key once the last
 *  listener goes, so an absent set reads as zero rather than undefined. */
function updateListeners(doc: Y.Doc): number {
	const observers = (doc as unknown as { _observers: Map<string, Set<unknown>> })._observers;
	return observers.get("update")?.size ?? 0;
}

describe("SharingEngine.resolveSiblingRoster — lifetime", () => {
	let dirOwner = "";
	let owner: VaultSession;
	let ports: LoopbackRelayPort[];
	let engine: SharingEngine;
	/** Every doc `resolveSiblingRoster` caused to be loaded, in order. */
	let loadedDocs: Y.Doc[];

	beforeEach(async () => {
		dirOwner = await mkdtemp(join(tmpdir(), "bs-roster-life-"));
		owner = await VaultSession.create({
			vaultId: "vlt_owner",
			vaultPath: dirOwner,
			forceInsecure: true,
		});
		ports = LoopbackRelayPort.pair(2);
		const p0 = ports[0];
		if (!p0) throw new Error("expected a loopback port");
		engine = new SharingEngine(owner, () => relayAdapter(p0));

		// Watch the load itself — the leak is one layer below the roster value,
		// so the roster cannot show it.
		loadedDocs = [];
		const store = owner.ydocStore;
		const realLoad = store.load.bind(store);
		store.load = async (entityId: string) => {
			const result = await realLoad(entityId);
			loadedDocs.push(result.doc);
			return result;
		};
	});

	afterEach(async () => {
		for (const p of ports) p.close();
		owner.dispose();
		await rm(dirOwner, { recursive: true, force: true });
	});

	async function rosterDevice(label: string, x25519PubB64: string): Promise<void> {
		const props = await VaultPropertiesStore.open(owner.ydocStore);
		props.devices().add(
			signAddDeviceRecord(
				{
					deviceEd25519Pub: `${label}-ed25519-pub`,
					deviceX25519Pub: x25519PubB64,
					deviceLabel: label,
					addedAt: Date.now(),
					addedBy: owner.identity.publicKeyBase64,
				},
				owner.exposeIdentityForPairing().secretKey,
			),
		);
		await props.flush();
		await props.close();
		loadedDocs.length = 0;
	}

	it("closes the doc it opened — no listener survives the read", async () => {
		await engine.resolveSiblingRoster();

		expect(loadedDocs).toHaveLength(1);
		for (const doc of loadedDocs) expect(updateListeners(doc)).toBe(0);
	});

	it("reads the doc ONCE across many entity writes, not once per write", async () => {
		await engine.resolveSiblingRoster();
		await engine.resolveSiblingRoster();
		await engine.resolveSiblingRoster();

		// The ongoing producer resolves per entity. Before 10.3d(a) this was three
		// file reads, three Y.Docs and three listeners for three notes.
		expect(loadedDocs).toHaveLength(1);
	});

	it("shares ONE load between concurrent writes racing the first read", async () => {
		await Promise.all([
			engine.resolveSiblingRoster(),
			engine.resolveSiblingRoster(),
			engine.resolveSiblingRoster(),
		]);

		expect(loadedDocs).toHaveLength(1);
	});

	it("re-reads after a pairing, so a new device is never fanned a stale roster", async () => {
		const before = await engine.resolveSiblingRoster();
		expect(before).toHaveLength(0);

		await rosterDevice("Second device", owner.deviceX25519.publicKeyBase64);
		// What `onDevicesChanged` does the moment the device list moves.
		engine.invalidateSiblingRoster();

		const after = await engine.resolveSiblingRoster();
		expect(after).toHaveLength(1);
		// …and the re-read closed its doc too.
		for (const doc of loadedDocs) expect(updateListeners(doc)).toBe(0);
	});

	it("without the invalidation, a pairing would go unseen — pins why the hook exists", async () => {
		await engine.resolveSiblingRoster();
		await rosterDevice("Second device", owner.deviceX25519.publicKeyBase64);

		// Deliberately NOT invalidating: this is the failure the wiring in
		// `onDevicesChanged` prevents, pinned so removing that call turns a test
		// red rather than silently stranding the device.
		expect(await engine.resolveSiblingRoster()).toHaveLength(0);

		engine.invalidateSiblingRoster();
		expect(await engine.resolveSiblingRoster()).toHaveLength(1);
	});
});
