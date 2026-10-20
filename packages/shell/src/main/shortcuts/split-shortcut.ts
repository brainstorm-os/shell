/** Shell shortcut ids for split view (6.14). Renderer-free so both the
 *  registry and the main-process action runner can import it. */
export enum SplitShortcut {
	Open = "shell/split.open",
	FocusOther = "shell/split.focus-other",
	Swap = "shell/split.swap",
	DividerLeft = "shell/split.divider-left",
	DividerRight = "shell/split.divider-right",
}
