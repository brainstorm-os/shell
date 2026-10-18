/**
 * 7.17 — run the Settings → General startup page once after the vault unlocks.
 *
 * Everything routes through the shell's one open path (`intent.open`), so the
 * IntentsBus picks the opener exactly as a pin or a search hit would. Today's
 * Journal entry has a stable id (`journal-<local YYYY-MM-DD>`, owned by the
 * Journal app) that Journal resolves to the right day even before the entry
 * exists; if no handler takes it (entry not created yet), launching Journal
 * fresh lands on — and creates — today.
 *
 * "Once" is per vault per window session (`sessionStorage`), so a renderer
 * reload or a lock/unlock cycle doesn't re-open it, while a vault switch does.
 */

import {
	DEFAULT_STARTUP_PAGE,
	type StartupPage,
	StartupPageKind,
} from "@brainstorm-os/protocol/shell-prefs";
import { useEffect, useRef } from "react";

export const JOURNAL_APP_ID = "io.brainstorm.journal";
const JOURNAL_ENTRY_ID_PREFIX = "journal-";
const RAN_KEY_PREFIX = "bs.startup-page.ran/";

export function todayJournalEntryId(now: Date): string {
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${JOURNAL_ENTRY_ID_PREFIX}${y}-${m}-${d}`;
}

export type StartupPageDeps = {
	/** `intent.open` for an entity; resolves whether a handler took it. */
	openEntity: (entityId: string) => Promise<boolean>;
	launchApp: (appId: string) => Promise<void>;
	now?: () => Date;
};

export async function runStartupPage(
	page: StartupPage | undefined,
	deps: StartupPageDeps,
): Promise<void> {
	const choice = page ?? DEFAULT_STARTUP_PAGE;
	switch (choice.kind) {
		case StartupPageKind.Dashboard:
			return;
		case StartupPageKind.Object:
			await deps.openEntity(choice.entityId);
			return;
		case StartupPageKind.TodayJournal: {
			const id = todayJournalEntryId(deps.now?.() ?? new Date());
			if (!(await deps.openEntity(id))) await deps.launchApp(JOURNAL_APP_ID);
			return;
		}
	}
}

/** True exactly once per vault per window session. Storage that throws
 *  (private mode, blocked) still runs it — at worst once per reload. */
export function claimStartupRun(
	vaultId: string,
	storage: Storage | null = sessionStorageOrNull(),
): boolean {
	const key = `${RAN_KEY_PREFIX}${vaultId}`;
	try {
		if (storage?.getItem(key)) return false;
		storage?.setItem(key, "1");
	} catch {
		// Unavailable storage: fall through and run.
	}
	return true;
}

function sessionStorageOrNull(): Storage | null {
	try {
		return typeof sessionStorage === "undefined" ? null : sessionStorage;
	} catch {
		return null;
	}
}

/** Dashboard binding: once `ready` (vault unlocked, first snapshot in), run the
 *  vault's startup page through the shell's open + launch paths. */
export function useStartupPage(
	vaultId: string | null,
	ready: boolean,
	page: StartupPage | undefined,
): void {
	const pageRef = useRef(page);
	pageRef.current = page;
	useEffect(() => {
		if (!ready || !vaultId || !claimStartupRun(vaultId)) return;
		void runStartupPage(pageRef.current, {
			openEntity: async (entityId) =>
				(await window.brainstorm.intents.dispatch({ verb: "open", payload: { entityId } })).handled,
			launchApp: (appId) => window.brainstorm.apps.launch(appId),
		}).catch((error: unknown) => {
			console.warn("[brainstorm] startup page failed:", error);
		});
	}, [vaultId, ready]);
}
