import type { VaultActivateResult } from "@brainstorm-os/protocol/vault-recovery-wire-types";
import { toVaultDbKind, toVaultRecovery } from "@brainstorm-os/protocol/vault-recovery-wire-types";
import { BrowserWindow, dialog, ipcMain } from "electron";
import type { DataStoreKind } from "../storage/data-stores";
import { VaultCorruptionError } from "../storage/recovery-plan";
import { detectCloudSync } from "../vault/cloud-sync";
import { defaultVaultPath } from "../vault/paths";
import { closeActiveVaultSession, getActiveVaultSession } from "../vault/session";
import {
	type CreateVaultOptions,
	activateVault,
	createVault,
	getDefaultVault,
	listVaults,
	openVault,
	recoverCorruptVault,
	scanForRecoveredVaults,
} from "../vault/vault";
import { getWorkersHandle } from "../workers";

/**
 * Re-open + cache the active vault's capability ledger on the broker so the
 * first app IPC after a session (re)open already has a hot ledger. Called after
 * every path that installs a new VaultSession — create / open / activate /
 * recover here, and the app-lock unlock (a hard-unlock re-opens a brand-new
 * session whose ledger.db the broker must re-cache; without this it would hold
 * the disposed session's closed handle).
 */
export async function warmupBroker(): Promise<void> {
	const handle = getWorkersHandle();
	if (!handle) return;
	await handle.context.warmupLedger();
}

/**
 * Run a vault open/recover attempt and shape the outcome as `VaultActivateResult`.
 * 12.8 (doc 28 §Recovery): a corrupt domain DB surfaces as a STRUCTURED result,
 * not a thrown error — IPC flattens an Error to its `message`, losing the
 * `{ kind, recovery }` the renderer needs to offer the right recovery path.
 * (search.db is auto-rebuilt deeper down; only the prompt-recovery kinds reach
 * here.) Any other error propagates unchanged.
 */
async function activateResultOf(attempt: () => Promise<void>): Promise<VaultActivateResult> {
	try {
		await attempt();
		return { ok: true };
	} catch (error) {
		if (error instanceof VaultCorruptionError) {
			return {
				ok: false,
				kind: toVaultDbKind(error.kind),
				recovery: toVaultRecovery(error.recovery),
			};
		}
		throw error;
	}
}

export function registerVaultHandlers(): void {
	ipcMain.handle("vaults:list", () => listVaults());
	ipcMain.handle("vaults:current", () => getDefaultVault());
	ipcMain.handle("vaults:default-path", (_event, name: string) => defaultVaultPath(name));
	ipcMain.handle("vaults:check-path", (_event, path: string) => detectCloudSync(path));

	ipcMain.handle("vaults:create", async (_event, options: CreateVaultOptions) => {
		const entry = await createVault(options);
		await warmupBroker();
		return entry;
	});

	ipcMain.handle("vaults:open-by-path", async (_event, path: string) => {
		const entry = await openVault(path);
		await warmupBroker();
		return entry;
	});

	// 12.8 (doc 28 §Recovery, "Vault registry corrupted"): recoverable vaults
	// the registry has forgotten, scanned read-only from disk. The picker offers
	// these as an "Add back" surface; re-registering goes through open-by-path.
	ipcMain.handle("vaults:scan-recovered", () => scanForRecoveredVaults());

	ipcMain.handle(
		"vaults:activate",
		(_event, id: string): Promise<VaultActivateResult> =>
			activateResultOf(async () => {
				await activateVault(id);
				await warmupBroker();
			}),
	);

	// 12.8 (doc 28 §Recovery, "Corrupted SQLite file"): after the user confirms,
	// archive the corrupt domain DB aside and re-activate — recreates it empty
	// (entities repopulates from sources; ledger/registry start fresh). If a
	// second DB is also corrupt the re-activate fails closed with the next kind.
	ipcMain.handle(
		"vaults:recover",
		(_event, id: string, kind: DataStoreKind): Promise<VaultActivateResult> =>
			activateResultOf(async () => {
				await recoverCorruptVault(id, kind);
				await warmupBroker();
			}),
	);

	ipcMain.handle("vaults:session", () => {
		const session = getActiveVaultSession();
		return session ? session.meta : null;
	});

	ipcMain.handle("vaults:close", () => {
		closeActiveVaultSession();
	});

	ipcMain.handle("credentials:list", (_event, app: string) => {
		const session = requireActiveSession();
		return session.listCredentials(app);
	});

	ipcMain.handle("credentials:get", async (_event, app: string, key: string) => {
		const session = requireActiveSession();
		const value = await session.getCredential({ app, key });
		return value ? Buffer.from(value).toString("base64") : null;
	});

	ipcMain.handle(
		"credentials:set",
		async (_event, app: string, key: string, valueBase64: string) => {
			const session = requireActiveSession();
			const value = new Uint8Array(Buffer.from(valueBase64, "base64"));
			await session.setCredential({ app, key }, value);
		},
	);

	ipcMain.handle("credentials:delete", (_event, app: string, key: string) => {
		const session = requireActiveSession();
		return session.deleteCredential({ app, key });
	});

	ipcMain.handle("vaults:pick-folder", async (event, mode: "create" | "open") => {
		const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
		const properties: ("openDirectory" | "createDirectory" | "promptToCreate")[] =
			mode === "create" ? ["openDirectory", "createDirectory", "promptToCreate"] : ["openDirectory"];
		const result = win
			? await dialog.showOpenDialog(win, {
					properties,
					title: mode === "create" ? "Choose a folder for your new vault" : "Open vault",
				})
			: await dialog.showOpenDialog({
					properties,
					title: mode === "create" ? "Choose a folder for your new vault" : "Open vault",
				});
		if (result.canceled || result.filePaths.length === 0) return null;
		return result.filePaths[0];
	});
}

function requireActiveSession() {
	const session = getActiveVaultSession();
	if (!session) {
		throw new Error("No active vault session — open a vault first.");
	}
	return session;
}
