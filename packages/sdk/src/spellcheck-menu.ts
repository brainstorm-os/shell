/**
 * Spellcheck suggestion menu (B11.16c). Electron shows no native context menu,
 * so when the user right-clicks a misspelled word the shell pushes the word +
 * Chromium suggestions to the renderer; this mounts ONE listener per app that
 * renders the suggestions through the shared fancy-menus runtime (the
 * consistent-interface rule — never a bespoke menu). Picking a suggestion
 * replaces the word via `runtime.spellcheck.replace` (Electron-native
 * `replaceMisspelling` on the calling renderer's current selection).
 *
 * Requires the app to have mounted the fancy-menus host (`mountMenuHost`).
 * Degrades to a no-op when `runtime.spellcheck` is absent (standalone/preview
 * shells) — squiggles still show, just no suggestion menu. See
 * editing/60-spellcheck.md.
 */

import type { SpellcheckBridge, SpellcheckContext } from "@brainstorm-os/sdk-types";
import { type ContextMenuItem, openContextMenu } from "./menus";

export type SpellcheckMenuLabels = {
	/** Shown (disabled) when Chromium has no suggestions for the word. */
	noSuggestions: string;
	/** "Add to dictionary" — persists the word to the vault dictionary (B11.17a). */
	addToDictionary: string;
	/** "Ignore" — suppresses the word for this session only (B11.17a). */
	ignore: string;
};

export const DEFAULT_SPELLCHECK_MENU_LABELS: SpellcheckMenuLabels = {
	noSuggestions: "No suggestions",
	addToDictionary: "Add to dictionary",
	ignore: "Ignore",
};

/** The actions a suggestion menu can take on the misspelled word. */
export type SpellcheckMenuActions = {
	onReplace: (replacement: string) => void;
	onAddWord: (word: string) => void;
	onIgnore: (word: string) => void;
};

/**
 * Build the suggestion menu rows for a spellcheck context. Pure. Suggestions
 * (or a disabled "No suggestions" row) come first, then a divider and the
 * dictionary actions (Add to dictionary / Ignore) for the misspelled word.
 */
export function buildSpellMenuItems(
	ctx: SpellcheckContext,
	labels: SpellcheckMenuLabels,
	actions: SpellcheckMenuActions,
): ContextMenuItem[] {
	const items: ContextMenuItem[] =
		ctx.suggestions.length === 0
			? [{ id: "spellcheck-none", label: labels.noSuggestions, disabled: true }]
			: ctx.suggestions.map((suggestion, index) => ({
					id: `spellcheck-suggestion-${index}`,
					label: suggestion,
					onSelect: () => actions.onReplace(suggestion),
				}));
	items.push({ id: "spellcheck-divider", label: "", divider: true });
	items.push({
		id: "spellcheck-add",
		label: labels.addToDictionary,
		onSelect: () => actions.onAddWord(ctx.word),
	});
	items.push({
		id: "spellcheck-ignore",
		label: labels.ignore,
		onSelect: () => actions.onIgnore(ctx.word),
	});
	return items;
}

/**
 * Mount the spellcheck suggestion menu against `bridge` (`runtime.spellcheck`).
 * Returns an unsubscribe. No-op (returns a no-op disposer) when the shell
 * exposes no spellcheck bridge — standalone/preview shells degrade to squiggles.
 */
export function mountSpellcheckMenu(
	bridge: SpellcheckBridge | undefined,
	labels: SpellcheckMenuLabels = DEFAULT_SPELLCHECK_MENU_LABELS,
): () => void {
	if (!bridge) return () => {};
	return bridge.onContext((ctx) => {
		const items = buildSpellMenuItems(ctx, labels, {
			onReplace: (replacement) => bridge.replace(replacement),
			onAddWord: (word) => void bridge.addWord(word).catch(() => {}),
			onIgnore: (word) => void bridge.ignoreWord(word).catch(() => {}),
		});
		openContextMenu({ x: ctx.x, y: ctx.y }, items);
	});
}

/**
 * Mount the spellcheck menu reading the bridge from the runtime global
 * (`window.brainstorm.spellcheck`, exposed by the shell preload). The uniform
 * one-liner every prose app calls after `mountMenuHost()` — no per-app runtime
 * typing. No-op on shells/standalone drops without the bridge.
 */
export function mountSpellcheckMenuFromWindow(
	labels: SpellcheckMenuLabels = DEFAULT_SPELLCHECK_MENU_LABELS,
): () => void {
	const runtime = (globalThis as { brainstorm?: { spellcheck?: SpellcheckBridge } }).brainstorm;
	return mountSpellcheckMenu(runtime?.spellcheck, labels);
}
