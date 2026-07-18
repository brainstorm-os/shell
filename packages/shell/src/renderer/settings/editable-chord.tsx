/**
 * `<EditableChord>` — interactive rebinding row for Settings → Keyboard
 * (6.10f).
 *
 * Three modes:
 *   1. **idle**   — chord tokens render as `<kbd>`s; clicking the row /
 *                   pressing Enter / Space enters capture.
 *   2. **capture** — live keydown listener attaches; `captureChord(event)`
 *                   resolves the keystroke into a `Mod`-tokenized chord;
 *                   pure-modifier presses keep the surface armed.
 *   3. **save / cancel** — chord is staged; the user commits with Save
 *                   (or Enter), backs out with Cancel (or Escape). Reset
 *                   reverts to the default chord at any time.
 *
 * Round-trip: capture writes `Mod`-tokenized chords. `setOverride` over
 * IPC commits to the registry + persists into the shortcut-bindings
 * entity + broadcasts `shortcuts:bindings-changed`. The hook listening
 * to that channel picks it up and the surface repaints.
 *
 * Conflict awareness: the renderer checks live bindings *before* sending
 * setOverride; the main-side handler defends the boundary on its own
 * (see `shortcuts-handlers.ts` `SetOverrideErrorReason.Conflict`) so a
 * stale renderer can't end-run the check.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
	BindingSource,
	SetOverrideErrorReason,
	type ShortcutBindingRow,
} from "../../shortcut-binding-types";
import { t } from "../i18n/t";
import { captureChord } from "../shortcuts/chord-capture";
import { formatChord, isMacPlatform } from "../shortcuts/chord-display";
import type { ShortcutBindings } from "../shortcuts/use-shortcut-bindings";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";

export enum EditableChordMode {
	Idle = "idle",
	Capture = "capture",
}

type StageState = {
	/** Mod-tokenized chord the user has captured but not yet saved. */
	readonly chord: string;
	/** Conflict row (other binding) if the chord collides. */
	readonly conflict: ShortcutBindingRow | null;
};

export type EditableChordProps = {
	readonly row: ShortcutBindingRow;
	readonly bindings: ShortcutBindings;
	readonly onSetOverride: (
		id: string,
		chord: string | null,
	) => Promise<{
		readonly ok: boolean;
		readonly reason?: SetOverrideErrorReason | "unknown-id" | "no-registry";
	}>;
	readonly onReset: (id: string) => Promise<{ readonly ok: boolean }>;
	/** Translated row label (already through `t()`). Used in aria-labels +
	 *  conflict copy. */
	readonly translatedLabel: string;
};

export function EditableChord({
	row,
	bindings,
	onSetOverride,
	onReset,
	translatedLabel,
}: EditableChordProps) {
	const mac = isMacPlatform();
	const [mode, setMode] = useState<EditableChordMode>(EditableChordMode.Idle);
	const [stage, setStage] = useState<StageState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const rowRef = useRef<HTMLDivElement>(null);
	const captureRef = useRef<HTMLButtonElement>(null);
	// `bindings` is unstable (new object every parent render). Hold it in
	// a ref so the keydown listener always reads the latest snapshot
	// without re-attaching on every re-render.
	const bindingsRef = useRef(bindings);
	bindingsRef.current = bindings;

	const cancelCapture = useCallback((): void => {
		setMode(EditableChordMode.Idle);
		setStage(null);
		setError(null);
	}, []);

	// Capture-mode keydown listener — local to the captured button so the
	// shell's global before-input-event matcher (which doesn't reach the
	// renderer here) and other useShortcut hooks stay out of the way.
	useEffect(() => {
		if (mode !== EditableChordMode.Capture) return;
		captureRef.current?.focus();
		const node = captureRef.current;
		if (!node) return;
		const listener = (event: KeyboardEvent) => {
			// Capture mode owns every key while the surface is armed.
			event.preventDefault();
			event.stopPropagation();

			// Escape exits capture without staging anything (treated as Cancel).
			if (event.key === "Escape") {
				cancelCapture();
				return;
			}

			const result = captureChord(event);
			if (result.isModifierOnly) {
				// Still waiting for the non-modifier key — surface a quiet
				// "keep waiting" hint instead of a hard error.
				setError(t("shell.settings.keyboard.captureKeepWaiting"));
				return;
			}

			const chord = result.chord;
			const conflict = findConflict(chord, row.id, bindingsRef.current);
			setStage({ chord, conflict });
			setError(null);
		};
		node.addEventListener("keydown", listener);
		return () => node.removeEventListener("keydown", listener);
	}, [mode, row.id, cancelCapture]);

	// Click-outside dismissal (the popover-primitive precedent). Replaces
	// the earlier `onBlur={cancelCapture}` so clicking Save/Cancel/Clear
	// routes through their own onClick handlers consistently — the blur
	// path used to unmount the action buttons before mouseup, leaving
	// dead-code click handlers.
	useEffect(() => {
		if (mode !== EditableChordMode.Capture) return;
		const handle = (event: MouseEvent): void => {
			const target = event.target as Node | null;
			if (target && rowRef.current?.contains(target)) return;
			cancelCapture();
		};
		document.addEventListener("mousedown", handle);
		return () => document.removeEventListener("mousedown", handle);
	}, [mode, cancelCapture]);

	const isOverridden = row.source !== BindingSource.Default;

	const beginCapture = (): void => {
		setMode(EditableChordMode.Capture);
		// Pre-stage the current chord so the user sees what they're replacing.
		setStage({ chord: row.chord ?? "", conflict: null });
		setError(null);
	};

	const commitStage = async (): Promise<void> => {
		if (!stage) return;
		if (stage.chord === "") return;
		if (stage.conflict) return;
		setBusy(true);
		try {
			const result = await onSetOverride(row.id, stage.chord);
			if (!result.ok) {
				setError(reasonCopy(result.reason));
				return;
			}
			setMode(EditableChordMode.Idle);
			setStage(null);
			setError(null);
		} finally {
			setBusy(false);
		}
	};

	const clearChord = async (): Promise<void> => {
		setBusy(true);
		try {
			const result = await onSetOverride(row.id, null);
			if (!result.ok) {
				setError(reasonCopy(result.reason));
				return;
			}
			setMode(EditableChordMode.Idle);
			setStage(null);
			setError(null);
		} finally {
			setBusy(false);
		}
	};

	const resetToDefault = async (): Promise<void> => {
		setBusy(true);
		try {
			const result = await onReset(row.id);
			if (!result.ok) {
				setError(t("shell.settings.keyboard.savingError"));
			}
		} finally {
			setBusy(false);
		}
	};

	if (mode === EditableChordMode.Capture && stage) {
		const tokens = stage.chord === "" ? [] : formatChord(stage.chord, mac);
		const conflictLabel = stage.conflict ? labelForRow(stage.conflict) : null;
		const canSave =
			stage.chord !== "" && stage.chord !== (row.chord ?? "") && !stage.conflict && !busy;
		return (
			<div
				ref={rowRef}
				className="keyboard__row-capture"
				role="group"
				aria-label={t("shell.settings.keyboard.edit")}
			>
				<button
					ref={captureRef}
					type="button"
					className={`keyboard__capture-target ${stage.conflict ? "keyboard__capture-target--conflict" : ""}`}
					aria-label={t("shell.settings.keyboard.editAria", { label: translatedLabel })}
					data-bs-capture-active="true"
				>
					{tokens.length === 0 ? (
						<span className="keyboard__capture-prompt">{t("shell.settings.keyboard.capturePrompt")}</span>
					) : (
						tokens.map((tok, i) => (
							<kbd key={`${i}-${tok}`} className="keyboard__key keyboard__key--capture">
								{tok}
							</kbd>
						))
					)}
				</button>
				<div className="keyboard__capture-status" aria-live="polite">
					{stage.conflict && conflictLabel ? (
						<span className="keyboard__capture-error">
							{t("shell.settings.keyboard.conflict", { label: conflictLabel })}
						</span>
					) : error ? (
						<span className="keyboard__capture-hint">{error}</span>
					) : null}
				</div>
				<div className="keyboard__capture-actions">
					<Button
						variant={ButtonVariant.Ghost}
						size={ButtonSize.Md}
						onClick={cancelCapture}
						disabled={busy}
					>
						{t("shell.settings.keyboard.cancel")}
					</Button>
					<Button variant={ButtonVariant.Ghost} size={ButtonSize.Md} onClick={clearChord} loading={busy}>
						{t("shell.settings.keyboard.clear")}
					</Button>
					<Button
						variant={ButtonVariant.Primary}
						size={ButtonSize.Md}
						onClick={commitStage}
						loading={busy}
						disabled={!canSave}
					>
						{t("shell.settings.keyboard.save")}
					</Button>
				</div>
			</div>
		);
	}

	// Idle: chord tokens + Edit / Reset affordances.
	const tokens = formatChord(row.chord, mac);
	const ariaLabel = isOverridden
		? `${t("shell.settings.keyboard.editAria", { label: translatedLabel })} · ${t("shell.settings.keyboard.overrideBadge")}`
		: t("shell.settings.keyboard.editAria", { label: translatedLabel });
	return (
		<div ref={rowRef} className="keyboard__row-idle">
			<button
				type="button"
				className={`keyboard__chord-button${isOverridden ? " keyboard__chord-button--overridden" : ""}`}
				onClick={beginCapture}
				aria-label={ariaLabel}
			>
				{tokens.length === 0 ? (
					<span className="keyboard__chord-empty">{t("shell.settings.keyboard.unbound")}</span>
				) : (
					tokens.map((tok, i) => (
						<kbd key={`${i}-${tok}`} className="keyboard__key">
							{tok}
						</kbd>
					))
				)}
				{isOverridden ? <span className="keyboard__override-dot" aria-hidden="true" /> : null}
			</button>
			{isOverridden ? (
				<Button
					variant={ButtonVariant.Ghost}
					size={ButtonSize.Md}
					onClick={resetToDefault}
					loading={busy}
					title={t("shell.settings.keyboard.resetAria", { label: translatedLabel })}
				>
					{t("shell.settings.keyboard.reset")}
				</Button>
			) : null}
		</div>
	);
}

/** Find a binding (other than `selfId`) that would conflict with
 *  `chord` after normalization. Pure — exported for tests. */
export function findConflict(
	chord: string,
	selfId: string,
	bindings: ShortcutBindings,
): ShortcutBindingRow | null {
	const normalized = normalizeForCompare(chord);
	if (normalized === "") return null;
	for (const candidate of bindings.rows) {
		if (candidate.id === selfId) continue;
		if (candidate.chord === null) continue;
		if (normalizeForCompare(candidate.chord) === normalized) return candidate;
	}
	return null;
}

/** Renderer-local normalize for the conflict check — mirrors the
 *  modifier-collapse rules in `main/shortcuts/chord.ts` so the
 *  renderer-side warning matches the main-side defensive rejection. */
function normalizeForCompare(chord: string): string {
	const parts = chord
		.split("+")
		.map((p) => p.trim())
		.filter(Boolean);
	if (parts.length === 0) return "";
	const mods: string[] = [];
	const keys: string[] = [];
	for (const part of parts) {
		const lower = part.toLowerCase();
		const canon = MOD_ALIASES[lower];
		if (canon) mods.push(canon);
		else keys.push(lower);
	}
	mods.sort();
	if (keys.length === 0 && mods.length > 0) keys.push(mods.pop() ?? "");
	const uniq: string[] = [];
	for (const m of mods) if (!uniq.includes(m)) uniq.push(m);
	return [...uniq, ...keys].join("+");
}

const MOD_ALIASES: Record<string, string> = {
	cmd: "cmd",
	command: "cmd",
	meta: "cmd",
	super: "cmd",
	ctrl: "ctrl",
	control: "ctrl",
	cmdorctrl: "cmdorctrl",
	commandorcontrol: "cmdorctrl",
	mod: "cmdorctrl",
	alt: "alt",
	option: "alt",
	shift: "shift",
};

function labelForRow(row: ShortcutBindingRow): string {
	// Try the same i18n key the row would normally render with; fall back
	// to the registry's label (English).
	const key = labelKeyForRowId(row.id);
	if (key !== null) {
		const translated = t(key);
		// `[?key]` is the missing-translation marker; show the raw label
		// instead so the conflict copy doesn't surface debug syntax.
		if (!translated.startsWith("[?")) return translated;
	}
	return row.label;
}

const ROW_LABEL_KEYS: Record<string, string> = {
	"shell/launcher": "shell.settings.keyboard.action.launcher",
	"shell/search": "shell.settings.keyboard.action.search",
	"shell/settings": "shell.settings.keyboard.action.settings",
	"shell/marketplace": "shell.settings.keyboard.action.marketplace",
	"shell/bin": "shell.settings.keyboard.action.bin",
	"shell/cheatsheet": "shell.settings.keyboard.action.cheatsheet",
	"shell/help": "shell.settings.keyboard.action.help",
	"shell/appearance.toggle": "shell.settings.keyboard.action.appearance",
	"shell/vault-switcher": "shell.settings.keyboard.action.vaultSwitcher",
	"shell/new": "shell.settings.keyboard.action.new",
	"shell/switch-window": "shell.settings.keyboard.action.switchWindow",
	"shell/close-window": "shell.settings.keyboard.action.closeWindow",
	"shell/quit": "shell.settings.keyboard.action.quit",
};

function labelKeyForRowId(id: string): string | null {
	return ROW_LABEL_KEYS[id] ?? null;
}

/** Translate a setOverride failure reason into surfaceable copy. Routes
 *  bare-modifier + conflict (already handled inline) to their specific
 *  strings and falls back to the generic save error. */
function reasonCopy(reason?: SetOverrideErrorReason | "unknown-id" | "no-registry"): string {
	switch (reason) {
		case SetOverrideErrorReason.BareModifier:
			return t("shell.settings.keyboard.bareModifier");
		case SetOverrideErrorReason.Conflict:
			// Conflict is normally caught client-side, but the main-side
			// boundary also rejects. The renderer surfaces the staged
			// chord's conflict copy inline; this is the defensive
			// fallback when the client-side check missed.
			return t("shell.settings.keyboard.conflict", { label: "" });
		default:
			return t("shell.settings.keyboard.savingError");
	}
}
