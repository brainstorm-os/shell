import { track } from "@brainstorm/sdk/analytics";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from "react";
import type { CloudSyncWarning, CreateVaultOptions, VaultEntry } from "../preload";
import type { VaultDbKind, VaultRecovery } from "../shared/vault-recovery-wire-types";
import { ToastKind, pushToast } from "./ui/toasts";

/** 12.8 — an open attempt that hit a corrupt domain DB the storage layer won't
 *  auto-repair. The dashboard surfaces an actionable recovery prompt; on the
 *  user's confirmation `recoverCorruption()` archives the DB and re-activates. */
export type VaultRecoveryPrompt = {
	id: string;
	kind: VaultDbKind;
	recovery: VaultRecovery;
};

type VaultContextValue = {
	current: VaultEntry | null;
	allVaults: VaultEntry[];
	loading: boolean;
	create: (options: CreateVaultOptions) => Promise<VaultEntry>;
	openByPath: (path: string) => Promise<VaultEntry>;
	pickFolder: (mode: "create" | "open") => Promise<string | null>;
	defaultPath: (name: string) => Promise<string>;
	checkPath: (path: string) => Promise<CloudSyncWarning | null>;
	activate: (id: string) => Promise<void>;
	close: () => Promise<void>;
	refresh: () => Promise<void>;
	/** Pending corrupt-vault recovery prompt, or null. 12.8. */
	recoveryPrompt: VaultRecoveryPrompt | null;
	/** Confirm the pending recovery (archive the corrupt DB + re-activate). If a
	 *  second DB is also corrupt, the prompt updates to that kind; otherwise it
	 *  clears on success. */
	recoverCorruption: () => Promise<void>;
	/** Dismiss the recovery prompt without mutating (the restore-from-backup
	 *  path: the user fixes files on disk and reopens). */
	dismissRecovery: () => void;
};

const VaultContext = createContext<VaultContextValue | null>(null);

export function VaultProvider({ children }: { children: ReactNode }) {
	const [current, setCurrent] = useState<VaultEntry | null>(null);
	const [allVaults, setAllVaults] = useState<VaultEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [recoveryPrompt, setRecoveryPrompt] = useState<VaultRecoveryPrompt | null>(null);

	const refresh = useCallback(async () => {
		const [list, active, session] = await Promise.all([
			window.brainstorm.vaults.list(),
			window.brainstorm.vaults.current(),
			window.brainstorm.vaults.session(),
		]);
		setAllVaults(list);
		// `current` reflects what main-process can actually serve. Registry
		// having a defaultVaultId without a live VaultSession (e.g. keystore
		// lost the identity on dev-restart) is treated as "no current vault";
		// the welcome screen surfaces so the user can re-open or re-create.
		const live = active && session && session.vaultId === active.id ? active : null;
		setCurrent(live);
	}, []);

	useEffect(() => {
		void (async () => {
			try {
				await refresh();
			} finally {
				setLoading(false);
			}
		})();
	}, [refresh]);

	// The dashboard window persists across a vault switch (not remounted), so a
	// switch this renderer didn't initiate — a main-side activation, or a vault
	// created/opened through the raw preload bridge rather than the React
	// methods below — never runs the `refresh()` those callbacks do. Subscribe
	// to the main-side `vaults:active-changed` push so `current` tracks the live
	// session regardless of who switched it; without this the theme stays pinned
	// to the welcome-screen Midnight (effectiveTheme's `!hasVault` gate) and the
	// welcome/dashboard routing to the stale surface. Optional-chained so a
	// stale preload bundle (no HMR) can't crash the dashboard.
	useEffect(() => {
		return window.brainstorm.vaults?.onActiveChanged?.(() => void refresh());
	}, [refresh]);

	const create = useCallback(
		async (options: CreateVaultOptions) => {
			try {
				const entry = await window.brainstorm.vaults.create(options);
				// Event name only — never send vault / identity ids to analytics.
				track("Vault Created");
				await refresh();
				return entry;
			} catch (error) {
				pushToast({
					kind: ToastKind.Error,
					title: "Couldn't create vault",
					body: (error as Error).message,
				});
				throw error;
			}
		},
		[refresh],
	);

	const openByPath = useCallback(
		async (path: string) => {
			try {
				const entry = await window.brainstorm.vaults.openByPath(path);
				await refresh();
				return entry;
			} catch (error) {
				pushToast({
					kind: ToastKind.Error,
					title: "Couldn't open vault",
					body: (error as Error).message,
				});
				throw error;
			}
		},
		[refresh],
	);

	const activate = useCallback(
		async (id: string) => {
			try {
				const result = await window.brainstorm.vaults.activate(id);
				if (!result.ok) {
					// 12.8 — a corrupt domain DB the storage layer won't auto-repair.
					// Raise the actionable recovery prompt (re-init / rebuild /
					// restore-from-backup) rather than a dead-end error toast.
					setRecoveryPrompt({ id, kind: result.kind, recovery: result.recovery });
				}
			} catch (error) {
				pushToast({
					kind: ToastKind.Error,
					title: "Couldn't open vault",
					body: (error as Error).message,
				});
			} finally {
				await refresh();
			}
		},
		[refresh],
	);

	const recoverCorruption = useCallback(async () => {
		const prompt = recoveryPrompt;
		if (!prompt) return;
		try {
			const result = await window.brainstorm.vaults.recover(prompt.id, prompt.kind);
			if (result.ok) {
				setRecoveryPrompt(null);
			} else {
				// A second DB was also corrupt — re-prompt for the next one
				// rather than silently looping.
				setRecoveryPrompt({ id: prompt.id, kind: result.kind, recovery: result.recovery });
			}
		} catch (error) {
			setRecoveryPrompt(null);
			pushToast({
				kind: ToastKind.Error,
				title: "Couldn't recover vault",
				body: (error as Error).message,
			});
		} finally {
			await refresh();
		}
	}, [recoveryPrompt, refresh]);

	const dismissRecovery = useCallback(() => setRecoveryPrompt(null), []);

	const close = useCallback(async () => {
		try {
			await window.brainstorm.vaults.close();
			await refresh();
		} catch (error) {
			pushToast({
				kind: ToastKind.Error,
				title: "Couldn't sign out",
				body: (error as Error).message,
			});
			throw error;
		}
	}, [refresh]);

	const value: VaultContextValue = {
		current,
		allVaults,
		loading,
		create,
		openByPath,
		pickFolder: window.brainstorm.vaults.pickFolder,
		defaultPath: window.brainstorm.vaults.defaultPath,
		checkPath: window.brainstorm.vaults.checkPath,
		activate,
		close,
		refresh,
		recoveryPrompt,
		recoverCorruption,
		dismissRecovery,
	};

	return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): VaultContextValue {
	const value = useContext(VaultContext);
	if (!value) throw new Error("useVault must be used inside <VaultProvider>");
	return value;
}
