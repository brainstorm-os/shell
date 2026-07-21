/**
 * LocaleGate (Track A) — applies the active UI language at runtime and remounts
 * its subtree when the language changes so `t()` (a module singleton) is re-read
 * with the new catalog.
 *
 * The language comes from the per-vault dashboard snapshot, so a second device
 * inherits it. Because `t()` is called inline during render, a context value
 * change alone wouldn't re-translate already-rendered components — keying the
 * subtree on the applied language forces the remount. Switching language is a
 * rare, explicit action, so the remount cost is acceptable.
 *
 * Pre-vault surfaces (vault picker, lock screen) render before a vault is open,
 * so before a vault's synced `locale` map is available they fall back to the
 * last language applied on this device (12.15 slice 15e — `last-locale.ts`),
 * not hardcoded English.
 */

import { DEFAULT_LANGUAGE } from "@brainstorm-os/protocol/shell-prefs";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { useDashboard } from "../dashboard/use-dashboard";
import { readLastLocale, rememberLastLocale } from "./last-locale";
import { loadAndApplyLocale } from "./locale-pack-loader";

export function LocaleGate({ children }: { children: ReactNode }) {
	const snapshot = useDashboard();
	// Pre-vault (no snapshot yet) falls back to the device's last applied
	// language so the picker / lock screen open in it; once a vault is open its
	// synced language wins.
	const language = snapshot?.locale.language ?? readLastLocale();
	// `applied` flips to the new language only after its pack has loaded, so the
	// remount happens with the catalog already in place (no English flash).
	const [applied, setApplied] = useState(DEFAULT_LANGUAGE);

	useEffect(() => {
		if (language === applied) return;
		let cancelled = false;
		void loadAndApplyLocale(language).then(() => {
			if (cancelled) return;
			setApplied(language);
			// Persist whatever just took effect (the vault language post-open, or
			// the remembered one pre-vault) so the next boot's pre-vault surfaces
			// match.
			rememberLastLocale(language);
		});
		return () => {
			cancelled = true;
		};
	}, [language, applied]);

	return <Fragment key={applied}>{children}</Fragment>;
}
