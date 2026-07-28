/**
 * Collab-C4-live — dev-only IPC handlers exposing the C1/C2 share flow so two
 * real shells (two different *users*) can dogfood collaboration through the
 * shipped app. Registered ONLY when `!app.isPackaged` (dev) AND
 * `BRAINSTORM_COLLAB_DEBUG=1`; production builds never expose these channels,
 * and a normal dev session also doesn't — the env-gate keeps the surface
 * invisible outside a deliberate collab-dogfood run.
 *
 * These are thin wrappers over {@link CollabDevBridge} (the testable core in
 * `main/collab/collab-dev-bridge.ts`). The bridge is bound lazily to the
 * active vault session + the live relay (`getActiveRelay`); a vault swap
 * rebuilds it. Channels (privileged, dashboard-only via the preload bridge —
 * never reachable through the capability broker, so apps cannot call them):
 *
 *   - `dev:collab:whoami` — this shell's `{userPubB64, x25519PubB64}`.
 *   - `dev:collab:create-invite` — collaborator mints a self-signed ShareInvite.
 *   - `dev:collab:provision-entity` — owner creates the entity + DEK + owner grant.
 *   - `dev:collab:install-share-receiver` — subscribe + apply wrap/update frames.
 *   - `dev:collab:share` — owner grants + wraps + emits; returns access members.
 *   - `dev:collab:edit-text` — append scratch text + emit the delta.
 *   - `dev:collab:revoke` — owner revokes a member (append-only audit).
 *   - `dev:collab:access` — resolved access log (active + revoked).
 *   - `dev:collab:state-vector` — `Y.encodeStateVector` of the persisted doc.
 *   - `dev:collab:read-text` — the scratch text (content-level convergence check).
 *   - `dev:collab:bind-asset` — Asset-B4: mint an encrypted asset + bind it to an
 *     entity through the production reconcile/upload paths.
 *   - `dev:collab:asset-status` — row/blob/manifest observability for one pair.
 *   - `dev:collab:materialize-asset` — Asset-B4: materialise bytes on access
 *     (reconstruct → local blob, else lazy fetch off the durable node).
 *   - `dev:collab:read-asset-local` — the LOCAL bytes only (lazy-fetch probe).
 */

import { Buffer } from "node:buffer";
import { ipcMain } from "electron";
import {
	type CollabAssetDeps,
	CollabDevBridge,
	type CollabRelayLike,
	parseAccessRole,
} from "../collab/collab-dev-bridge";
import { isShareInvite } from "../collab/share-invite";
import { getActiveRelay } from "../sync/active-relay";
import { getActiveVaultSession } from "../vault/session";
import { assertDevEntityId } from "./dev-entity-id";

/** Asset bytes cross this dev IPC as base64; cap the decoded size well under
 *  anything the harness needs so a runaway spec can't balloon the channel. */
const MAX_DEV_ASSET_BYTES = 8 * 1024 * 1024;

const PROPERTY_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

let bound: { bridge: CollabDevBridge; vaultId: string } | null = null;
let boundAssetDeps: CollabAssetDeps | null = null;

function bridgeForSession(): CollabDevBridge {
	const session = getActiveVaultSession();
	if (!session) throw new Error("dev:collab: no active vault session");
	if (!bound || bound.vaultId !== session.vaultId) {
		bound?.bridge.dispose();
		bound = {
			bridge: new CollabDevBridge(
				session,
				() => getActiveRelay() as CollabRelayLike | null,
				boundAssetDeps,
			),
			vaultId: session.vaultId,
		};
	}
	return bound.bridge;
}

function assertType(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error("dev:collab: type must be a non-empty string");
	}
}

export function registerCollabDevHandlers(assetDeps: CollabAssetDeps | null = null): () => void {
	boundAssetDeps = assetDeps;
	ipcMain.handle("dev:collab:whoami", async () => bridgeForSession().whoami());

	ipcMain.handle("dev:collab:create-invite", async (_event, label: unknown) => {
		if (typeof label !== "string" || label.length === 0) {
			throw new Error("dev:collab:create-invite: label must be a non-empty string");
		}
		return bridgeForSession().createInvite(label);
	});

	ipcMain.handle(
		"dev:collab:provision-entity",
		async (_event, entityId: unknown, type: unknown, properties: unknown) => {
			assertDevEntityId(entityId);
			assertType(type);
			const props =
				properties && typeof properties === "object"
					? (properties as Record<string, unknown>)
					: undefined;
			await bridgeForSession().provisionEntity(entityId, type, props);
			return { ok: true };
		},
	);

	ipcMain.handle(
		"dev:collab:install-share-receiver",
		async (_event, entityId: unknown, type: unknown) => {
			assertDevEntityId(entityId);
			assertType(type);
			await bridgeForSession().installShareReceiver(entityId, type);
			return { ok: true };
		},
	);

	ipcMain.handle(
		"dev:collab:share",
		async (_event, entityId: unknown, type: unknown, invite: unknown, role: unknown) => {
			assertDevEntityId(entityId);
			assertType(type);
			if (!isShareInvite(invite)) {
				throw new Error("dev:collab:share: invite is not a well-formed ShareInvite");
			}
			return bridgeForSession().share({
				entityId,
				type,
				invite,
				role: parseAccessRole(role),
			});
		},
	);

	ipcMain.handle(
		"dev:collab:share-collection",
		async (_event, entityId: unknown, type: unknown, invite: unknown, role: unknown) => {
			assertDevEntityId(entityId);
			assertType(type);
			if (!isShareInvite(invite)) {
				throw new Error("dev:collab:share-collection: invite is not a well-formed ShareInvite");
			}
			return bridgeForSession().shareCollection({
				entityId,
				type,
				invite,
				role: parseAccessRole(role),
			});
		},
	);

	ipcMain.handle("dev:collab:edit-text", async (_event, entityId: unknown, text: unknown) => {
		assertDevEntityId(entityId);
		if (typeof text !== "string") {
			throw new Error("dev:collab:edit-text: text must be a string");
		}
		await bridgeForSession().editText(entityId, text);
		return { ok: true };
	});

	ipcMain.handle("dev:collab:revoke", async (_event, entityId: unknown, memberB64: unknown) => {
		assertDevEntityId(entityId);
		if (typeof memberB64 !== "string" || memberB64.length === 0) {
			throw new Error("dev:collab:revoke: memberB64 must be a non-empty string");
		}
		return { revoked: await bridgeForSession().revoke(entityId, memberB64) };
	});

	ipcMain.handle("dev:collab:access", async (_event, entityId: unknown) => {
		assertDevEntityId(entityId);
		return bridgeForSession().access(entityId);
	});

	ipcMain.handle("dev:collab:state-vector", async (_event, entityId: unknown) => {
		assertDevEntityId(entityId);
		return Array.from(await bridgeForSession().stateVector(entityId));
	});

	ipcMain.handle("dev:collab:read-text", async (_event, entityId: unknown) => {
		assertDevEntityId(entityId);
		return bridgeForSession().readText(entityId);
	});

	ipcMain.handle(
		"dev:collab:publish-presence",
		async (_event, entityId: unknown, appId: unknown, state: unknown) => {
			assertDevEntityId(entityId);
			if (typeof appId !== "string" || appId.length === 0) {
				throw new Error("dev:collab:publish-presence: appId must be a non-empty string");
			}
			const payload =
				state === null || (state && typeof state === "object" && !Array.isArray(state))
					? (state as Record<string, unknown> | null)
					: null;
			bridgeForSession().publishPresence(entityId, appId, payload);
			return { ok: true };
		},
	);

	ipcMain.handle("dev:collab:presence-remote-peers", async (_event, entityId: unknown) => {
		assertDevEntityId(entityId);
		return bridgeForSession().presenceRemotePeers(entityId);
	});

	// Asset-B4 — bind an encrypted asset to an entity through the production
	// paths (AssetStore mint → entities.update with a `brainstorm://asset/` URL →
	// implicit-bind reconcile → upload-on-bind → DEK re-home). Bytes ride base64.
	ipcMain.handle(
		"dev:collab:bind-asset",
		async (_event, entityId: unknown, bytesB64: unknown, mime: unknown, propertyKey: unknown) => {
			assertDevEntityId(entityId);
			if (typeof bytesB64 !== "string" || bytesB64.length === 0) {
				throw new Error("dev:collab:bind-asset: bytesB64 must be a non-empty base64 string");
			}
			if (typeof mime !== "string" || mime.length === 0) {
				throw new Error("dev:collab:bind-asset: mime must be a non-empty string");
			}
			if (typeof propertyKey !== "string" || !PROPERTY_KEY_RE.test(propertyKey)) {
				throw new Error("dev:collab:bind-asset: invalid propertyKey");
			}
			const bytes = new Uint8Array(Buffer.from(bytesB64, "base64"));
			if (bytes.length === 0 || bytes.length > MAX_DEV_ASSET_BYTES) {
				throw new Error(`dev:collab:bind-asset: bytes must be 1..${MAX_DEV_ASSET_BYTES}`);
			}
			return bridgeForSession().bindAsset(entityId, bytes, mime, propertyKey);
		},
	);

	ipcMain.handle("dev:collab:asset-status", async (_event, entityId: unknown, assetId: unknown) => {
		assertDevEntityId(entityId);
		assertDevEntityId(assetId);
		return bridgeForSession().assetStatus(entityId, assetId);
	});

	ipcMain.handle(
		"dev:collab:materialize-asset",
		async (_event, entityId: unknown, assetId: unknown) => {
			assertDevEntityId(entityId);
			assertDevEntityId(assetId);
			const got = await bridgeForSession().materializeAssetOnAccess(entityId, assetId);
			return got
				? { bytesB64: Buffer.from(got.bytes).toString("base64"), mime: got.mime, source: got.source }
				: null;
		},
	);

	ipcMain.handle("dev:collab:read-asset-local", async (_event, assetId: unknown) => {
		assertDevEntityId(assetId);
		const got = await bridgeForSession().readAssetLocal(assetId);
		return got ? { bytesB64: Buffer.from(got.bytes).toString("base64"), mime: got.mime } : null;
	});

	return () => {
		for (const ch of [
			"dev:collab:whoami",
			"dev:collab:create-invite",
			"dev:collab:provision-entity",
			"dev:collab:install-share-receiver",
			"dev:collab:share",
			"dev:collab:share-collection",
			"dev:collab:edit-text",
			"dev:collab:revoke",
			"dev:collab:access",
			"dev:collab:state-vector",
			"dev:collab:read-text",
			"dev:collab:publish-presence",
			"dev:collab:presence-remote-peers",
			"dev:collab:bind-asset",
			"dev:collab:asset-status",
			"dev:collab:materialize-asset",
			"dev:collab:read-asset-local",
		]) {
			ipcMain.removeHandler(ch);
		}
		bound?.bridge.dispose();
		bound = null;
		boundAssetDeps = null;
	};
}
