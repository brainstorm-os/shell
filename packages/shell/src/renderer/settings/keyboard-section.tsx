/**
 * Keyboard shortcuts settings section — interactive rebinding (6.10f).
 *
 * Each row carries a live `<EditableChord>`. Bindings come from the
 * main-process registry over the `shortcuts:*` IPC surface — the seed
 * map in `default-chords.ts` is only the cold-start fallback. User
 * rebinds persist into the vault's `brainstorm/ShortcutBindings/v1`
 * entity and travel across macOS / Windows installs because every
 * captured chord is **`Mod`-tokenized** (`Mod+Shift+P`, not
 * `Cmd+Shift+P`).
 *
 * Layout: the grouped-rows definition (`SHORTCUT_GROUPS`) is shared
 * with the 6.9 cheatsheet overlay, so adding an action there surfaces
 * here automatically.
 */

import type {
	ResetOverrideResult,
	SetOverrideResult,
} from "@brainstorm-os/protocol/shortcut-binding-types";
import { t } from "../i18n/t";
import { formatChord, isMacPlatform } from "../shortcuts/chord-display";
import { SHORTCUT_GROUPS } from "../shortcuts/shortcut-groups";
import { useShortcutBindings } from "../shortcuts/use-shortcut-bindings";
import { EditableChord } from "./editable-chord";

const NULL_RESULT: SetOverrideResult = { ok: true } as const;
const NULL_RESET: ResetOverrideResult = { ok: true } as const;

type ShortcutsBridge = {
	setOverride(id: string, chord: string | null): Promise<SetOverrideResult>;
	resetOverride(id: string): Promise<ResetOverrideResult>;
};

function bridge(): ShortcutsBridge | null {
	const win = typeof window === "undefined" ? null : window;
	const wb = win as (Window & { brainstorm?: { shortcuts?: ShortcutsBridge } }) | null;
	return wb?.brainstorm?.shortcuts ?? null;
}

export function KeyboardSection() {
	const bindings = useShortcutBindings();
	const mac = isMacPlatform();

	const setOverride = async (id: string, chord: string | null): Promise<SetOverrideResult> => {
		const svc = bridge();
		if (!svc) return NULL_RESULT;
		return svc.setOverride(id, chord);
	};
	const resetOverride = async (id: string): Promise<ResetOverrideResult> => {
		const svc = bridge();
		if (!svc) return NULL_RESET;
		return svc.resetOverride(id);
	};

	return (
		<section className="settings__section keyboard">
			<p className="settings__hint">{t("shell.settings.keyboard.hint")}</p>
			{SHORTCUT_GROUPS.map((group) => (
				<div key={group.titleKey} className="keyboard__group">
					<h4 className="settings__section-title">{t(group.titleKey)}</h4>
					<ul className="keyboard__list">
						{group.rows.map((groupRow) => {
							const liveRow = bindings.rowFor(groupRow.id);
							const translatedLabel = t(groupRow.labelKey);
							// Only ids registered with the main-process registry
							// can round-trip through `shortcuts:set-override` —
							// renderer-seed-only ids (`app/nav.*`, `editor/find`,
							// `shell/popover.*`, `shell/list.*`) live in the
							// component-scoped layer and aren't user-rebindable
							// in v1. Render them read-only here so the user
							// doesn't get an opaque "Couldn't save" toast on Save.
							if (liveRow === null) {
								const seedChord = bindings.chordFor(groupRow.id);
								const tokens = formatChord(seedChord, mac);
								return (
									<li key={groupRow.id} className="keyboard__row">
										<span className="keyboard__label">{translatedLabel}</span>
										<span
											className="keyboard__chord"
											aria-label={
												tokens.length === 0 ? t("shell.settings.keyboard.unbound") : tokens.join(" ")
											}
										>
											{tokens.length === 0 ? (
												<span className="keyboard__chord-empty">{t("shell.settings.keyboard.unbound")}</span>
											) : (
												tokens.map((token, i) => (
													<kbd key={`${groupRow.id}-${i}`} className="keyboard__key">
														{token}
													</kbd>
												))
											)}
										</span>
									</li>
								);
							}
							return (
								<li key={groupRow.id} className="keyboard__row">
									<span className="keyboard__label">{translatedLabel}</span>
									<EditableChord
										row={liveRow}
										bindings={bindings}
										onSetOverride={setOverride}
										onReset={resetOverride}
										translatedLabel={translatedLabel}
									/>
								</li>
							);
						})}
					</ul>
				</div>
			))}
		</section>
	);
}
