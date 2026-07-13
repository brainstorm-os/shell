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
 */

import { ipcMain } from "electron";
import {
	CollabDevBridge,
	type CollabRelayLike,
	parseAccessRole,
} from "../collab/collab-dev-bridge";
import { isShareInvite } from "../collab/share-invite";
import { getActiveRelay } from "../sync/active-relay";
import { getActiveVaultSession } from "../vault/session";
import { assertDevEntityId } from "./dev-entity-id";

let bound: { bridge: CollabDevBridge; vaultId: string } | null = null;

function bridgeForSession(): CollabDevBridge {
	const session = getActiveVaultSession();
	if (!session) throw new Error("dev:collab: no active vault session");
	if (!bound || bound.vaultId !== session.vaultId) {
		bound?.bridge.dispose();
		bound = {
			bridge: new CollabDevBridge(session, () => getActiveRelay() as CollabRelayLike | null),
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

export function registerCollabDevHandlers(): () => void {
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
		]) {
			ipcMain.removeHandler(ch);
		}
		bound?.bridge.dispose();
		bound = null;
	};
}
