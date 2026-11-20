/**
 * In-process, multi-vault proof (CLAUDE.md §4) of what a shared chat channel is
 * FOR: a message any member posts reaches every other member, in both
 * directions.
 *
 * Each peer is the production stack end to end, joined the way `main/index.ts`
 * joins it - a real `VaultSession`, the real `entities` service over the real
 * ydoc worker handler, the real change emitter + `createAutoShareReactor`, a
 * real `SharingEngine`, and a real `LiveSyncEngine` whose receive gates are the
 * production ones (`createSyncAuthz`, the same closures `main/index.ts` uses).
 * The peers meet over a CHANNEL-ROUTED, forward-only relay (frames fan by
 * `route ?? entityId` to current subscribers and are never stored), which is
 * the routing model of the shell's relay server and the reason the inbox path
 * exists at all.
 *
 * A message is posted through `entities.create`, exactly as the Chat app does:
 * nothing here calls the cascade by hand.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityLedger as CapabilityLedgerType } from "@brainstorm-os/capabilities/ledger";
import { MESSAGE_TYPE_URL } from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __ydocCacheResetForTest, handleYDocEnvelope } from "../../workers/ydoc";
import { AccessRole, activeMembers, getAccessArray } from "../collab/access-record";
import { createAutoShareReactor } from "../collab/auto-share-reactor";
import { inboxChannelFor } from "../collab/inbox-channel";
import { ShareBootstrapVerdict } from "../collab/share-bootstrap-authz";
import { SharingEngine } from "../collab/sharing-engine";
import { createSyncAuthz } from "../collab/sync-authz";
import { base64ToBytes, bytesToBase64, generateSymmetricKey } from "../credentials/crypto";
import { ED25519_PUBLIC_BYTES, verifySignature } from "../credentials/identity";
import { listWraps, wrapDekForRecipient, wrapDekVersionOf } from "../credentials/member-wraps";
import { type ApplyRemoteDocFn, makeEntitiesServiceHandler } from "../entities/entities-service";
import { EntityChangeEmitter } from "../entities/entity-change-emitter";
import { installEntityDek } from "../entities/install-wrap";
import { base64UrlToBytes } from "../pairing/pairing-channel";
import { EntitiesRepository, ShareInvitesRepository } from "../storage/entities-repo";
import { decodeFrame } from "../sync/envelope-codec";
import { emitWrapBootstrap } from "../sync/envelope-pipeline";
import { LiveSyncEngine } from "../sync/live-sync-engine";
import type { RelayPort, RelaySurface } from "../sync/relay-port";
import { makeRemoteDocApplier } from "../sync/remote-doc-applier";
import { WireKind } from "../sync/routing-header";
import { VaultSession } from "../vault/session";

const CHAT_APP = "io.brainstorm.chat";
const CHANNEL_TYPE = "io.brainstorm.chat/Channel/v1";

type Forwarded = { from: string; to: string; entityId: string; kind: WireKind; frame: Uint8Array };

/** A forward-only relay that fans each frame to the OTHER connections
 *  currently subscribed to its `route ?? entityId`. Nothing is stored: a frame
 *  sent while a peer is offline, or before it subscribed, is gone. */
class ChannelRelay {
	readonly #subs = new Map<string, Set<string>>();
	readonly #listeners = new Map<string, Set<(f: Uint8Array) => void>>();
	readonly #offline = new Set<string>();
	readonly forwarded: Forwarded[] = [];

	connection(connId: string): RelaySurface {
		const listen = (cb: (f: Uint8Array) => void): void => {
			let set = this.#listeners.get(connId);
			if (!set) {
				set = new Set();
				this.#listeners.set(connId, set);
			}
			set.add(cb);
		};
		const port: RelayPort = {
			send: (frame) => this.#route(connId, frame),
			onFrame: listen,
			offFrame: (cb) => this.#listeners.get(connId)?.delete(cb),
			close: () => undefined,
		};
		return {
			currentPort: () => port,
			onFrame: listen,
			offFrame: (cb) => this.#listeners.get(connId)?.delete(cb),
			subscribe: (key) => {
				let set = this.#subs.get(key);
				if (!set) {
					set = new Set();
					this.#subs.set(key, set);
				}
				set.add(connId);
			},
			unsubscribe: (key) => this.#subs.get(key)?.delete(connId),
		};
	}

	setOffline(connId: string, offline: boolean): void {
		if (offline) this.#offline.add(connId);
		else this.#offline.delete(connId);
	}

	#route(from: string, frame: Uint8Array): void {
		if (this.#offline.has(from)) return;
		const { header } = decodeFrame(frame);
		const key = header.route ?? header.entityId;
		for (const to of this.#subs.get(key) ?? []) {
			if (to === from || this.#offline.has(to)) continue;
			this.forwarded.push({ from, to, entityId: header.entityId, kind: header.kind, frame });
			for (const cb of this.#listeners.get(to) ?? []) cb(new Uint8Array(frame));
		}
	}
}

type Peer = Awaited<ReturnType<typeof makePeer>>;

/** One member's shell, wired as `main/index.ts` wires it. */
async function makePeer(name: string, relay: ChannelRelay) {
	const vaultPath = await mkdtemp(join(tmpdir(), `bs-channel-${name}-`));
	const session = await VaultSession.create({
		vaultId: `vlt_channel_${name}`,
		vaultPath,
		forceInsecure: true,
	});
	const surface = relay.connection(name);
	const dekStore = await session.entityDekStore();
	const entitiesDb = await session.dataStores.open("entities");
	const repo = new EntitiesRepository(entitiesDb);
	const shareInvites = new ShareInvitesRepository(entitiesDb);
	const refusals: string[] = [];
	/** Entity ids this shell told its app windows to re-list for. */
	const repaints: string[] = [];

	let applyRemoteDoc: ApplyRemoteDocFn | null = null;
	const changes = new EntityChangeEmitter();
	let idSeq = 0;
	let live: LiveSyncEngine | null = null;
	const entities = makeEntitiesServiceHandler({
		getRepo: async () => repo,
		getLedger: async () => ({ has: () => true }) as unknown as CapabilityLedgerType,
		getDekStore: async () => dekStore,
		newId: () => {
			idSeq += 1;
			return `ent_${name}_${idSeq}`;
		},
		getVaultPath: () => vaultPath,
		onEntityChange: (change) => changes.emit(change),
		onDocOpened: (entityId, type) => {
			void live?.trackOpen(entityId, type);
		},
		onLocalDocUpdate: (entityId, _type, update) => {
			void live?.noteLocalUpdate(entityId, update);
		},
		bindApplyRemoteDoc: (fn) => {
			applyRemoteDoc = fn;
		},
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

	// The production gates, as `main/index.ts` builds them.
	const accessTrust = await session.accessTrust();
	const syncAuthz = createSyncAuthz({
		session,
		dekStore,
		accessTrust,
		shareInvites,
		typeOf: (id) => repo.get(id)?.type ?? null,
		onBootstrapRefused: (entityId, verdict) => refusals.push(`${entityId}: ${verdict}`),
	});

	live = new LiveSyncEngine({
		getRelay: () => surface,
		dekStore,
		devicePub: session.identity.publicKey,
		deviceSign: (bytes) => session.signPayload(bytes),
		deviceVerify: (sig, bytes, senderPub) => verifySignature(senderPub, bytes, sig),
		resolveEntityType: () => null,
		isShared: syncAuthz.isShared,
		authorizeWriter: syncAuthz.authorizeWriter,
		applyRemoteUpdate: makeRemoteDocApplier({
			apply: () => applyRemoteDoc,
			onApplied: (entityId) => {
				repaints.push(entityId);
				// As `main/index.ts`: the root owner re-asserts its record whenever a
				// remote update lands on an entity it owns.
				void sharing.reassertRecord(entityId);
			},
		}),
		installWrap: async (wrap, entityId, senderPubB64) => {
			if (!(await syncAuthz.authorizeWrapInstall(entityId, senderPubB64))) return null;
			if (wrap.recipientPubB64 !== bytesToBase64(session.deviceX25519.publicKey)) return null;
			const { dek, type } = session.unwrapMemberWrapWithType(wrap, entityId);
			try {
				if (!repo.get(entityId)) {
					if (!type) return null;
					repo.create({
						id: entityId,
						type,
						properties: {},
						createdBy: "brainstorm",
						now: Date.now(),
						dekId: null,
					});
				}
				installEntityDek(entityId, dek, wrapDekVersionOf(wrap), dekStore, repo);
				return type;
			} finally {
				dek.fill(0);
			}
		},
	});
	live.start();
	const liveEngine = live;

	// ONE engine for the share verbs and the create hook, as in production
	// (`makeEngineHolder` caches per session).
	const sharing = new SharingEngine(session, () => surface);
	const cascadeErrors: unknown[] = [];
	const offReactor = createAutoShareReactor(changes, {
		getEngine: () => sharing,
		readEntityProperties: async (entityId) => repo.get(entityId)?.properties ?? null,
		onError: (error) => cascadeErrors.push(error),
		onShared: (entityId, type) => {
			void liveEngine.refreshMembership(entityId, type);
		},
	});

	const call = async (method: string, args: Record<string, unknown>): Promise<unknown> =>
		entities({
			v: 1,
			msg: "m",
			app: CHAT_APP,
			service: "entities",
			method,
			args: [args],
			caps: ["entities.read:*", "entities.write:*"],
		});

	return {
		name,
		session,
		sharing,
		live: liveEngine,
		repo,
		refusals,
		repaints,
		cascadeErrors,
		pub: session.identity.publicKeyBase64,
		/** Create an entity the way an app does. */
		create: async (type: string, properties: Record<string, unknown>): Promise<string> => {
			const reply = (await call("create", { type, properties })) as { id?: string } | null;
			return reply?.id ?? "";
		},
		/** Post a message the way the Chat app does. */
		post: async (channelId: string, body: string): Promise<string> => {
			const reply = (await call("create", {
				type: MESSAGE_TYPE_URL,
				// The shape `apps/chat` `buildMessageProperties` writes, for an author
				// who has set no display name.
				properties: {
					conversation: channelId,
					sender: {
						kind: "participant",
						personRef: session.identity.publicKeyBase64,
						displayName: "",
					},
					role: "user",
					body,
					createdAt: new Date().toISOString(),
					seq: idSeq,
				},
			})) as { id?: string } | null;
			return reply?.id ?? "";
		},
		/** Edit an entity's properties the way an app does. */
		edit: async (id: string, patch: Record<string, unknown>): Promise<void> => {
			await call("update", { id, patch });
		},
		/** The body this vault's index shows for a message, or null when the
		 *  message never arrived (no row, or a row with no content). */
		bodyOf: (messageId: string): string | null => {
			const body = repo.get(messageId)?.properties.body;
			return typeof body === "string" ? body : null;
		},
		activeMembersOf: async (entityId: string): Promise<string[]> => {
			const { doc } = await session.ydocStore.load(entityId);
			try {
				return activeMembers(doc, entityId, accessTrust.trustFor(doc, entityId))
					.map((m) => m.member)
					.sort();
			} finally {
				doc.destroy();
			}
		},
		/** The rotation ordinal of the DEK this vault currently holds for an entity. */
		dekVersionOf: async (entityId: string): Promise<number> => {
			const handle = dekStore.open(entityId);
			if (!handle) return 0;
			dekStore.close(handle.dek);
			return handle.version;
		},
		/** Does this vault's copy of the doc carry a wrap of the entity's CURRENT
		 *  key addressed to `other`'s device? */
		holdsCurrentWrapFor: async (
			entityId: string,
			other: { session: VaultSession },
		): Promise<boolean> => {
			const handle = dekStore.open(entityId);
			if (!handle) return false;
			dekStore.close(handle.dek);
			const { doc } = await session.ydocStore.load(entityId);
			try {
				const target = other.session.deviceX25519.publicKeyBase64;
				return listWraps(doc).some(
					(wrap) => wrap.recipientPubB64 === target && wrapDekVersionOf(wrap) === handle.version,
				);
			} finally {
				doc.destroy();
			}
		},
		/** Seal a key of this peer's choosing for `entityId` to `victim`'s device at
		 *  `version`, and drop it on their inbox — a forged rotation. */
		pushHostileKey: async (
			entityId: string,
			victim: { session: VaultSession; pub: string },
			version: number,
		): Promise<void> => {
			const wrap = wrapDekForRecipient(
				generateSymmetricKey(),
				victim.session.deviceX25519.publicKey,
				entityId,
				MESSAGE_TYPE_URL,
				version,
			);
			await emitWrapBootstrap(
				entityId,
				wrap,
				sharing.makeCtx(surface.currentPort()),
				inboxChannelFor(victim.pub),
			);
		},
		dispose: async (): Promise<void> => {
			offReactor();
			liveEngine.dispose();
			await session.dispose();
			await rm(vaultPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
				() => {},
			);
		},
	};
}

/** Let the fire-and-forget create hook and every receive chain drain. */
async function settle(peers: readonly Peer[]): Promise<void> {
	for (let round = 0; round < 6; round++) {
		await new Promise((r) => setTimeout(r, 15));
		for (const peer of peers) await peer.live.whenIdle();
	}
}

/** `owner` creates a channel as the Chat app does and shares it with `members`. */
async function sharedChannel(
	owner: Peer,
	members: ReadonlyArray<{ peer: Peer; role: AccessRole }>,
	all: readonly Peer[],
): Promise<string> {
	const channelId = await owner.create(CHANNEL_TYPE, { name: "general" });
	for (const { peer, role } of members) {
		const invite = await peer.sharing.createInvite(peer.name);
		await owner.sharing.shareCollection({ entityId: channelId, type: CHANNEL_TYPE, invite, role });
		await owner.live.refreshMembership(channelId, CHANNEL_TYPE);
		await settle(all);
	}
	return channelId;
}

describe("a shared chat channel carries every member's messages to every other member", () => {
	let relay: ChannelRelay;
	let peers: Peer[];

	beforeEach(() => {
		__ydocCacheResetForTest();
		relay = new ChannelRelay();
		peers = [];
	});

	afterEach(async () => {
		for (const peer of peers) await peer.dispose();
		__ydocCacheResetForTest();
	});

	async function boot(...names: string[]): Promise<Peer[]> {
		for (const name of names) peers.push(await makePeer(name, relay));
		return peers;
	}

	it("a message the owner posts reaches the member", async () => {
		const [mira, marcus] = (await boot("mira", "marcus")) as [Peer, Peer];
		const channel = await sharedChannel(mira, [{ peer: marcus, role: AccessRole.Editor }], peers);

		const message = await mira.post(channel, "kickoff at ten");
		await settle(peers);

		expect(marcus.bodyOf(message)).toBe("kickoff at ten");
		expect(marcus.refusals).toEqual([]);
		// Landing in the index is not arriving: an open channel only repaints when
		// the shell says an entity changed, and a remote apply bypasses the broker
		// wrapper that normally says so.
		expect(marcus.repaints).toContain(message);
	});

	// The two-shell dogfood specs build their channel through the dev bridge's
	// `provisionEntity`, which writes the Owner grant BEFORE any share. That grant
	// used to carry no wrapping key and `grantAccess` never replaces a live grant,
	// so the member's cascade had nobody to wrap to: this failed, silently, while
	// the app-created channel above passed.
	it("a member's message reaches the owner of a channel provisioned before it was shared", async () => {
		const [mira, marcus] = (await boot("mira", "marcus")) as [Peer, Peer];
		const channel = "ent_chan_provisioned";
		await mira.sharing.provisionEntity(channel, CHANNEL_TYPE, { name: "general" });
		const invite = await marcus.sharing.createInvite("marcus");
		await mira.sharing.shareCollection({
			entityId: channel,
			type: CHANNEL_TYPE,
			invite,
			role: AccessRole.Editor,
		});
		await settle(peers);

		const message = await marcus.post(channel, "can you see this?");
		await settle(peers);

		expect(mira.refusals).toEqual([]);
		expect(mira.bodyOf(message)).toBe("can you see this?");
	});

	it("a message a member posts in a shared channel reaches the owner (and every other member)", async () => {
		const [mira, marcus, priya] = (await boot("mira", "marcus", "priya")) as [Peer, Peer, Peer];
		const channel = await sharedChannel(
			mira,
			[
				{ peer: marcus, role: AccessRole.Editor },
				{ peer: priya, role: AccessRole.Editor },
			],
			peers,
		);

		const message = await marcus.post(channel, "I can take the venue");
		await settle(peers);

		expect(marcus.cascadeErrors).toEqual([]);
		expect(mira.refusals).toEqual([]);
		expect(priya.refusals).toEqual([]);
		expect(mira.bodyOf(message), "the owner sees the member's message").toBe("I can take the venue");
		expect(priya.bodyOf(message), "and so does the other member").toBe("I can take the venue");
		// The child's record is the channel's membership, no more and no less.
		expect(await marcus.activeMembersOf(message)).toEqual([mira.pub, marcus.pub, priya.pub].sort());
	});

	it("an edit to a message reaches the other side, whoever posted it and whoever edits it", async () => {
		const [mira, marcus] = (await boot("mira", "marcus")) as [Peer, Peer];
		const channel = await sharedChannel(mira, [{ peer: marcus, role: AccessRole.Editor }], peers);
		const fromMember = await marcus.post(channel, "frist draft");
		const fromOwner = await mira.post(channel, "agenda");
		await settle(peers);

		// The author edits their own message: the creator must be live-syncing a
		// child nobody ever opened.
		await marcus.edit(fromMember, { body: "first draft" });
		await mira.edit(fromOwner, { body: "agenda v2" });
		await settle(peers);
		expect(mira.bodyOf(fromMember)).toBe("first draft");
		expect(marcus.bodyOf(fromOwner)).toBe("agenda v2");

		// And the other member's edit comes back to the author.
		await mira.edit(fromMember, { pinned: true });
		await settle(peers);
		expect(marcus.repo.get(fromMember)?.properties.pinned).toBe(true);
	});

	it("receiving a message never re-triggers a cascade, and the relay only ever carries ciphertext", async () => {
		const [mira, marcus, priya] = (await boot("mira", "marcus", "priya")) as [Peer, Peer, Peer];
		const channel = await sharedChannel(
			mira,
			[
				{ peer: marcus, role: AccessRole.Editor },
				{ peer: priya, role: AccessRole.Editor },
			],
			peers,
		);
		const before = relay.forwarded.length;

		const secret = "the venue deposit is four thousand";
		const message = await marcus.post(channel, secret);
		await settle(peers);
		await settle(peers);

		const frames = relay.forwarded.slice(before).filter((f) => f.entityId === message);
		// Every frame about the message was sent by its author: no receiver echoed
		// it, re-granted it or re-wrapped it.
		expect(new Set(frames.map((f) => f.from))).toEqual(new Set(["marcus"]));
		// One wrap per other member, each delivered only to the member it is for.
		const wraps = frames.filter((f) => f.kind === WireKind.WrapBootstrap);
		expect(wraps.map((f) => f.to).sort()).toEqual(["mira", "priya"]);
		// The traffic has stopped: a storm would still be producing frames.
		const quiet = relay.forwarded.length;
		await settle(peers);
		expect(relay.forwarded.length).toBe(quiet);
		// Blind relay: the body crosses in no frame, in any encoding we emit.
		const needle = Buffer.from(secret, "utf8");
		for (const f of relay.forwarded) {
			expect(Buffer.from(f.frame).includes(needle)).toBe(false);
		}
	});

	it("nobody outside the channel's members receives the message or a key for it", async () => {
		const [mira, marcus, outsider] = (await boot("mira", "marcus", "outsider")) as [Peer, Peer, Peer];
		const channel = await sharedChannel(mira, [{ peer: marcus, role: AccessRole.Editor }], peers);
		// The outsider shares something ELSE with both, so they know its keys.
		const elsewhere = await sharedChannel(mira, [{ peer: outsider, role: AccessRole.Editor }], peers);
		expect(elsewhere).not.toBe(channel);
		const before = relay.forwarded.length;

		const message = await marcus.post(channel, "members only");
		await settle(peers);

		expect(mira.bodyOf(message)).toBe("members only");
		expect(outsider.repo.get(message)).toBeNull();
		expect(relay.forwarded.slice(before).some((f) => f.to === "outsider")).toBe(false);
		expect(await marcus.activeMembersOf(message)).toEqual([mira.pub, marcus.pub].sort());
	});

	it("a Viewer cannot post: their message is refused by every other member", async () => {
		const [mira, marcus, vera] = (await boot("mira", "marcus", "vera")) as [Peer, Peer, Peer];
		const channel = await sharedChannel(
			mira,
			[
				{ peer: marcus, role: AccessRole.Editor },
				{ peer: vera, role: AccessRole.Viewer },
			],
			peers,
		);

		const message = await vera.post(channel, "let me in");
		await settle(peers);

		expect(mira.bodyOf(message)).toBeNull();
		expect(marcus.bodyOf(message)).toBeNull();
		// Refused on the RECEIVING side, by the container-descent gate: the Viewer's
		// own shell cannot be trusted to refuse itself.
		for (const peer of [mira, marcus]) {
			expect(peer.refusals).toContain(
				`${message}: ${ShareBootstrapVerdict.DenyContainerGranterNotMember}`,
			);
			expect(peer.refusals.every((r) => r.startsWith(`${message}: deny-`))).toBe(true);
		}
		// A Viewer still READS what the others post.
		const fromOwner = await mira.post(channel, "read-only for you");
		await settle(peers);
		expect(vera.bodyOf(fromOwner)).toBe("read-only for you");
	});

	it("a revoked member's later messages are not accepted", async () => {
		const [mira, marcus, priya] = (await boot("mira", "marcus", "priya")) as [Peer, Peer, Peer];
		const channel = await sharedChannel(
			mira,
			[
				{ peer: marcus, role: AccessRole.Editor },
				{ peer: priya, role: AccessRole.Editor },
			],
			peers,
		);
		const earlier = await marcus.post(channel, "before the revoke");
		await settle(peers);
		expect(mira.bodyOf(earlier)).toBe("before the revoke");

		await mira.sharing.revoke(channel, marcus.pub);
		await settle(peers);

		const later = await marcus.post(channel, "after the revoke");
		await settle(peers);

		expect(mira.bodyOf(later)).toBeNull();
		expect(priya.bodyOf(later)).toBeNull();
		// And nobody's new message is wrapped to the revoked member.
		const fromOwner = await mira.post(channel, "without marcus");
		await settle(peers);
		expect(priya.bodyOf(fromOwner)).toBe("without marcus");
		expect(marcus.repo.get(fromOwner)).toBeNull();
		expect(await mira.activeMembersOf(fromOwner)).toEqual([mira.pub, priya.pub].sort());
	});

	// Design 71 flow 3. Removing a member from a channel has to hold for the
	// channel's HISTORY too: every message is its own entity with its own record,
	// and its author is that record's root owner, so no revoke on the message can
	// ever remove them from what they posted. The writer gate therefore also
	// asks the CONTAINER: a child is written only by a current Editor+ of the
	// container this device first saw it in.
	it("a revoked member cannot rewrite messages that predate the revoke", async () => {
		const [mira, marcus] = (await boot("mira", "marcus")) as [Peer, Peer];
		const channel = await sharedChannel(mira, [{ peer: marcus, role: AccessRole.Editor }], peers);
		const his = await marcus.post(channel, "his, before");
		const hers = await mira.post(channel, "hers, before");
		await settle(peers);
		await mira.sharing.revoke(channel, marcus.pub);
		await settle(peers);

		await marcus.edit(his, { body: "his, rewritten after the revoke" });
		await marcus.edit(hers, { body: "hers, rewritten after the revoke" });
		await settle(peers);

		expect([mira.bodyOf(his), mira.bodyOf(hers)]).toEqual(["his, before", "hers, before"]);
	});

	it("three members: after the owner removes one, their rewrites of ANYONE's earlier message are refused everywhere, and they cannot post", async () => {
		const [mira, marcus, priya] = (await boot("mira", "marcus", "priya")) as [Peer, Peer, Peer];
		const channel = await sharedChannel(
			mira,
			[
				{ peer: marcus, role: AccessRole.Editor },
				{ peer: priya, role: AccessRole.Editor },
			],
			peers,
		);
		const hers = await mira.post(channel, "mira, before");
		const his = await marcus.post(channel, "marcus, before");
		const theirs = await priya.post(channel, "priya, before");
		await settle(peers);
		expect([priya.bodyOf(hers), priya.bodyOf(his), mira.bodyOf(theirs)]).toEqual([
			"mira, before",
			"marcus, before",
			"priya, before",
		]);

		await mira.sharing.revoke(channel, marcus.pub);
		await settle(peers);

		for (const id of [hers, his, theirs]) await marcus.edit(id, { body: "rewritten by marcus" });
		const posted = await marcus.post(channel, "still here");
		await settle(peers);

		for (const peer of [mira, priya]) {
			expect([peer.bodyOf(hers), peer.bodyOf(his), peer.bodyOf(theirs)], peer.name).toEqual([
				"mira, before",
				"marcus, before",
				"priya, before",
			]);
			expect(peer.bodyOf(posted), peer.name).toBeNull();
		}
		// The two who remain still talk, and still edit what they wrote before.
		await priya.edit(theirs, { body: "priya, edited after" });
		await mira.edit(his, { body: "marcus, moderated by the owner" });
		await settle(peers);
		expect(mira.bodyOf(theirs)).toBe("priya, edited after");
		expect(priya.bodyOf(his)).toBe("marcus, moderated by the owner");
	});

	it("a revoked member cannot escape the container check by moving their message to a channel of their own", async () => {
		const [mira, marcus] = (await boot("mira", "marcus")) as [Peer, Peer];
		const channel = await sharedChannel(mira, [{ peer: marcus, role: AccessRole.Editor }], peers);
		const his = await marcus.post(channel, "his, before");
		await settle(peers);
		await mira.sharing.revoke(channel, marcus.pub);
		await settle(peers);

		const elsewhere = await marcus.create(CHANNEL_TYPE, { name: "mine" });
		await marcus.edit(his, { conversation: elsewhere, body: "moved and rewritten" });
		await settle(peers);

		expect(mira.repo.get(his)?.properties.conversation).toBe(channel);
		expect(mira.bodyOf(his)).toBe("his, before");
	});

	it("moving a message does not move who may write it: the container it was first seen in still decides", async () => {
		const [mira, marcus] = (await boot("mira", "marcus")) as [Peer, Peer];
		const channel = await sharedChannel(mira, [{ peer: marcus, role: AccessRole.Editor }], peers);
		const his = await marcus.post(channel, "his, before");
		await settle(peers);

		// While still a member he re-points it at a channel only he is in. The
		// property changes (it is content, and he may write content)…
		const elsewhere = await marcus.create(CHANNEL_TYPE, { name: "mine" });
		await marcus.edit(his, { conversation: elsewhere });
		await settle(peers);
		expect(mira.repo.get(his)?.properties.conversation).toBe(elsewhere);

		// …and it buys him nothing once he is removed from the original.
		await mira.sharing.revoke(channel, marcus.pub);
		await settle(peers);
		await marcus.edit(his, { body: "rewritten from the other channel" });
		await settle(peers);
		expect(mira.bodyOf(his)).toBe("his, before");
	});

	it("a member who LEAVES can no longer write the channel's messages either", async () => {
		const [mira, marcus] = (await boot("mira", "marcus")) as [Peer, Peer];
		const channel = await sharedChannel(mira, [{ peer: marcus, role: AccessRole.Editor }], peers);
		const his = await marcus.post(channel, "his, before");
		const hers = await mira.post(channel, "hers, before");
		await settle(peers);

		expect(await marcus.sharing.revoke(channel, marcus.pub)).toBe(true);
		await settle(peers);
		expect(await mira.activeMembersOf(channel)).toEqual([mira.pub]);

		await marcus.edit(his, { body: "from outside" });
		await marcus.edit(hers, { body: "from outside" });
		await settle(peers);
		expect([mira.bodyOf(his), mira.bodyOf(hers)]).toEqual(["his, before", "hers, before"]);
	});

	it("what the owner writes after removing a member is not readable by them — new messages AND edits to old ones", async () => {
		const [mira, marcus, priya] = (await boot("mira", "marcus", "priya")) as [Peer, Peer, Peer];
		const channel = await sharedChannel(
			mira,
			[
				{ peer: marcus, role: AccessRole.Editor },
				{ peer: priya, role: AccessRole.Editor },
			],
			peers,
		);
		const hers = await mira.post(channel, "hers, before");
		const his = await marcus.post(channel, "his, before");
		await settle(peers);

		await mira.sharing.revoke(channel, marcus.pub);
		await settle(peers);
		await mira.edit(hers, { body: "hers, after — not for marcus" });
		await mira.edit(his, { body: "his, moderated — not for marcus" });
		await settle(peers);

		// The survivor installed the rotated keys and reads both edits.
		expect(priya.bodyOf(hers)).toBe("hers, after — not for marcus");
		expect(priya.bodyOf(his)).toBe("his, moderated — not for marcus");
		// The removed member still has what was delivered before (not a goal to
		// take back) and nothing after.
		expect(marcus.bodyOf(hers)).toBe("hers, before");
		expect(marcus.bodyOf(his)).toBe("his, before");
		// No message carries a wrap of its CURRENT key for him.
		for (const id of [hers, his]) expect(await mira.holdsCurrentWrapFor(id, marcus), id).toBe(false);
	});

	it("a removed member cannot re-key a message, not even one they authored", async () => {
		const [mira, marcus] = (await boot("mira", "marcus")) as [Peer, Peer];
		const channel = await sharedChannel(mira, [{ peer: marcus, role: AccessRole.Editor }], peers);
		const his = await marcus.post(channel, "his, before");
		await settle(peers);
		await mira.sharing.revoke(channel, marcus.pub);
		await settle(peers);

		// He is the root owner of his own message, which is exactly who may rotate
		// an entity's key. He seals one of his choosing to the owner's device.
		const before = await mira.dekVersionOf(his);
		await marcus.pushHostileKey(his, mira, before + 1);
		await settle(peers);
		expect(await mira.dekVersionOf(his)).toBe(before);
	});

	it("a re-invited member posts again and is handed the history again", async () => {
		const [mira, marcus] = (await boot("mira", "marcus")) as [Peer, Peer];
		const channel = await sharedChannel(mira, [{ peer: marcus, role: AccessRole.Editor }], peers);
		const hers = await mira.post(channel, "hers, before");
		const his = await marcus.post(channel, "his, before");
		await settle(peers);
		await mira.sharing.revoke(channel, marcus.pub);
		await settle(peers);
		await mira.edit(hers, { body: "hers, while he was out" });
		await settle(peers);

		const invite = await marcus.sharing.createInvite("marcus");
		await mira.sharing.shareCollection({
			entityId: channel,
			type: CHANNEL_TYPE,
			invite,
			role: AccessRole.Editor,
		});
		await mira.live.refreshMembership(channel, CHANNEL_TYPE);
		await settle(peers);

		const posted = await marcus.post(channel, "back");
		await settle(peers);
		expect(mira.bodyOf(posted)).toBe("back");
		// The owner's earlier message comes back to him current, and he may edit
		// his own earlier one again.
		expect(marcus.bodyOf(hers)).toBe("hers, while he was out");
		await marcus.edit(his, { body: "his, edited after returning" });
		await settle(peers);
		expect(mira.bodyOf(his)).toBe("his, edited after returning");
	});

	it("the owner re-asserts a revoke a current member blanks out, as soon as the tampering reaches it", async () => {
		const [mira, marcus, priya] = (await boot("mira", "marcus", "priya")) as [Peer, Peer, Peer];
		const channel = await sharedChannel(
			mira,
			[
				{ peer: marcus, role: AccessRole.Editor },
				{ peer: priya, role: AccessRole.Editor },
			],
			peers,
		);
		await mira.sharing.revoke(channel, marcus.pub);
		await settle(peers);

		// Priya, still an Editor, blanks the revoke: an ordinary update from an
		// authorized writer, applied whole on every device.
		await priya.sharing.mutateAndEmit(channel, (doc) => {
			for (const entry of getAccessArray(doc).toArray()) {
				if (entry.get("member") !== marcus.pub) continue;
				entry.set("revokedAt", null);
				entry.set("revokedBy", null);
				entry.set("revokeSig", null);
			}
		});
		await settle(peers);

		// What the DOC says, with no device memory to lean on - which is all a
		// device that was offline for the revoke would have. The owner put the
		// revoke back without anyone touching the record again, and it travelled.
		for (const peer of [mira, priya]) {
			const { doc } = await peer.session.ydocStore.load(channel);
			try {
				const inDocAlone = activeMembers(doc, channel, { root: mira.pub }).map((m) => m.member);
				expect(inDocAlone, peer.name).not.toContain(marcus.pub);
			} finally {
				doc.destroy();
			}
		}
	});

	it("a message posted while a member is offline is NOT delivered later; the next one is", async () => {
		const [mira, marcus] = (await boot("mira", "marcus")) as [Peer, Peer];
		const channel = await sharedChannel(mira, [{ peer: marcus, role: AccessRole.Editor }], peers);

		relay.setOffline("mira", true);
		const missed = await marcus.post(channel, "sent into the void");
		await settle(peers);
		relay.setOffline("mira", false);
		const next = await marcus.post(channel, "back online");
		await settle(peers);

		expect(mira.bodyOf(next), "delivery resumes on reconnect").toBe("back online");
		// The relay forwards and forgets, and nothing re-sends a child's wrap, so
		// the message posted during the outage is still missing. This pins the
		// current limit so that closing it (a state request on subscribe, or the
		// durable node honouring the inbox route) has to change this line.
		expect(mira.bodyOf(missed)).toBeNull();
	});
});
