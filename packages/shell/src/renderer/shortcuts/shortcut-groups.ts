/**
 * Grouped shortcut reference data, shared between Settings → Keyboard and
 * the 6.9 cheatsheet overlay.
 *
 * Rows reference registry ids (`shell/launcher`, `editor/find`, …); the
 * effective chord is resolved at render time via `defaultChordFor` from
 * [default-chords.ts](./default-chords.ts) — the renderer-side seed that
 * mirrors the main-process registry. Once user overrides ship (live
 * registry push), the resolver can swap for the live source without
 * touching this declaration.
 */

export type ShortcutRow = {
	readonly id: string;
	readonly labelKey: string;
};

export type ShortcutGroup = {
	readonly titleKey: string;
	readonly rows: ReadonlyArray<ShortcutRow>;
};

export const SHORTCUT_GROUPS: ReadonlyArray<ShortcutGroup> = [
	{
		titleKey: "shell.settings.keyboard.group.workspace",
		rows: [
			{ id: "shell/launcher", labelKey: "shell.settings.keyboard.action.launcher" },
			{ id: "shell/search", labelKey: "shell.settings.keyboard.action.search" },
			{ id: "shell/settings", labelKey: "shell.settings.keyboard.action.settings" },
			{ id: "shell/marketplace", labelKey: "shell.settings.keyboard.action.marketplace" },
			{ id: "shell/bin", labelKey: "shell.settings.keyboard.action.bin" },
			{ id: "shell/cheatsheet", labelKey: "shell.settings.keyboard.action.cheatsheet" },
			{ id: "shell/help", labelKey: "shell.settings.keyboard.action.help" },
			{ id: "shell/appearance.toggle", labelKey: "shell.settings.keyboard.action.appearance" },
			{ id: "shell/vault-switcher", labelKey: "shell.settings.keyboard.action.vaultSwitcher" },
		],
	},
	{
		titleKey: "shell.settings.keyboard.group.window",
		rows: [
			{ id: "shell/new", labelKey: "shell.settings.keyboard.action.new" },
			{ id: "shell/switch-window", labelKey: "shell.settings.keyboard.action.switchWindow" },
			{ id: "shell/close-window", labelKey: "shell.settings.keyboard.action.closeWindow" },
			{ id: "shell/quit", labelKey: "shell.settings.keyboard.action.quit" },
			{ id: "shell/split.open", labelKey: "shell.settings.keyboard.action.splitOpen" },
			{ id: "shell/split.focus-other", labelKey: "shell.settings.keyboard.action.splitFocusOther" },
			{ id: "shell/split.swap", labelKey: "shell.settings.keyboard.action.splitSwap" },
			{ id: "shell/split.divider-left", labelKey: "shell.settings.keyboard.action.splitDividerLeft" },
			{
				id: "shell/split.divider-right",
				labelKey: "shell.settings.keyboard.action.splitDividerRight",
			},
		],
	},
	{
		titleKey: "shell.settings.keyboard.group.navigation",
		rows: [
			{ id: "app/nav.back", labelKey: "shell.settings.keyboard.action.navBack" },
			{ id: "app/nav.forward", labelKey: "shell.settings.keyboard.action.navForward" },
		],
	},
	{
		titleKey: "shell.settings.keyboard.group.document",
		rows: [
			{ id: "editor/find", labelKey: "shell.settings.keyboard.action.find" },
			{ id: "editor/find.replace", labelKey: "shell.settings.keyboard.action.replace" },
			{ id: "editor/find.next", labelKey: "shell.settings.keyboard.action.findNext" },
			{ id: "editor/find.previous", labelKey: "shell.settings.keyboard.action.findPrevious" },
			{ id: "editor/find.close", labelKey: "shell.settings.keyboard.action.findClose" },
		],
	},
	{
		titleKey: "shell.settings.keyboard.group.popovers",
		rows: [
			{ id: "shell/popover.close", labelKey: "shell.settings.keyboard.action.popoverClose" },
			{ id: "shell/popover.confirm", labelKey: "shell.settings.keyboard.action.popoverConfirm" },
			{
				id: "shell/popover.confirm-secondary",
				labelKey: "shell.settings.keyboard.action.popoverConfirmSecondary",
			},
			{ id: "shell/list.next", labelKey: "shell.settings.keyboard.action.listNext" },
			{ id: "shell/list.previous", labelKey: "shell.settings.keyboard.action.listPrevious" },
			{ id: "shell/list.cycle-next", labelKey: "shell.settings.keyboard.action.listCycleNext" },
			{
				id: "shell/list.cycle-previous",
				labelKey: "shell.settings.keyboard.action.listCyclePrevious",
			},
		],
	},
];
