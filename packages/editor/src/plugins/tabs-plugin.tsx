/**
 * TabsPlugin (B11.29) — `INSERT_TABS_COMMAND`, the tabs structure
 * transforms, per-device active-pane state, and the tab strip.
 *
 * The strip is React chrome portalled into each tabs block's non-content
 * host (`TabsNode.createDOM` reserves it; `getDOMSlot` keeps Lexical's
 * reconciler out of it). It follows the ARIA tabs pattern: a `tablist` with
 * roving focus (the shared composite keyboard), arrow keys move AND select
 * (automatic activation), each tab `aria-controls` its pane's `tabpanel`.
 *
 * A caret that lands in a hidden pane (arrow keys, find's reveal, an inbound
 * block anchor) switches the strip to that pane, so the selection is never
 * invisible.
 */

import { Orientation, useCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import {
	type ContextMenuItem,
	type IconComponent,
	type IconParam,
	MenuAlign,
	openContextMenu,
} from "@brainstorm-os/sdk/menus";
import { matchesChord } from "@brainstorm-os/sdk/shortcut";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useLexicalEditable } from "@lexical/react/useLexicalEditable";
import { mergeRegister } from "@lexical/utils";
import {
	$getNodeByKey,
	COMMAND_PRIORITY_EDITOR,
	type LexicalEditor,
	type NodeKey,
	createCommand,
} from "lexical";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { type EditorT, useEditorT } from "../i18n";
import { ArrowLeftIcon, ArrowRightIcon, MoreIcon, PlusIcon, RenameIcon, TrashIcon } from "../icons";
import {
	$isTabsNode,
	TAB_STRIP_HOST_CLASS,
	TabPaneNode,
	TabsNode,
	tabDomId,
	tabPanelDomId,
} from "../nodes/tabs-node";
import { resolveActivePane, tabsActiveStore } from "./tabs-active-store";
import {
	$addTab,
	$deleteTab,
	$insertTabs,
	$moveTab,
	$normalizeTabPane,
	$normalizeTabs,
	$renameTab,
	$selectionPane,
	$tabPanes,
	DEFAULT_TAB_COUNT,
} from "./tabs-ops";

export const INSERT_TABS_COMMAND = createCommand<number>("INSERT_TABS_COMMAND");

/** F2 starts renaming the focused tab — the keyboard twin of double-click. */
const RENAME_START_CHORD = "F2";
const RENAME_COMMIT_CHORDS = ["Enter"] as const;
const RENAME_CANCEL_CHORDS = ["Escape"] as const;

type PaneInfo = { key: NodeKey; title: string };

export function defaultTabTitle(t: EditorT, index: number): string {
	return t("editor.tabs.defaultTitle", { n: index + 1 });
}

function readPanes(editor: LexicalEditor, tabsKey: NodeKey): PaneInfo[] {
	return editor.getEditorState().read(() => {
		const tabs = $getNodeByKey(tabsKey);
		if (!$isTabsNode(tabs)) return [];
		return $tabPanes(tabs).map((p) => ({ key: p.getKey(), title: p.getTitle() }));
	});
}

function samePanes(a: readonly PaneInfo[], b: readonly PaneInfo[]): boolean {
	return a.length === b.length && a.every((p, i) => p.key === b[i]?.key && p.title === b[i]?.title);
}

/** Show the active pane of every tabs block, hide the rest. */
function applyPaneVisibility(editor: LexicalEditor, tabsKeys: Iterable<NodeKey>): void {
	const store = tabsActiveStore(editor);
	for (const tabsKey of tabsKeys) {
		const panes = readPanes(editor, tabsKey);
		const active = resolveActivePane(
			store.get(tabsKey),
			panes.map((p) => p.key),
		);
		for (const pane of panes) {
			const el = editor.getElementByKey(pane.key);
			if (!el) continue;
			if (pane.key === active) el.removeAttribute("hidden");
			else el.setAttribute("hidden", "");
		}
	}
}

export function TabsPlugin(): ReactNode {
	const [editor] = useLexicalComposerContext();
	const t = useEditorT();
	const [hosts, setHosts] = useState<ReadonlyMap<NodeKey, HTMLElement>>(new Map());

	useEffect(() => {
		if (!editor.hasNodes([TabsNode, TabPaneNode])) return;
		const store = tabsActiveStore(editor);
		const tracked = new Set<NodeKey>();
		const refreshHosts = (): void => {
			const next = new Map<NodeKey, HTMLElement>();
			for (const key of tracked) {
				const host = editor
					.getElementByKey(key)
					?.querySelector<HTMLElement>(`:scope > .${TAB_STRIP_HOST_CLASS}`);
				if (host) next.set(key, host);
			}
			setHosts(next);
		};
		return mergeRegister(
			editor.registerCommand(
				INSERT_TABS_COMMAND,
				(count) => {
					const n = Math.max(1, Math.min(8, Math.floor(count) || DEFAULT_TAB_COUNT));
					const titles = Array.from({ length: n }, (_, i) => defaultTabTitle(t, i));
					return $insertTabs(titles) !== null;
				},
				COMMAND_PRIORITY_EDITOR,
			),
			editor.registerNodeTransform(TabsNode, $normalizeTabs),
			editor.registerNodeTransform(TabPaneNode, $normalizeTabPane),
			editor.registerMutationListener(
				TabsNode,
				(mutations) => {
					for (const [key, mutation] of mutations) {
						if (mutation === "destroyed") tracked.delete(key);
						else tracked.add(key);
					}
					refreshHosts();
				},
				{ skipInitialization: false },
			),
			editor.registerUpdateListener(({ editorState }) => {
				const at = editorState.read($selectionPane);
				if (at) store.set(at.tabsKey, at.paneKey);
				applyPaneVisibility(editor, tracked);
			}),
			store.subscribe(() => applyPaneVisibility(editor, tracked)),
		);
	}, [editor, t]);

	return <>{[...hosts].map(([key, host]) => createPortal(<TabStrip tabsKey={key} />, host, key))}</>;
}

function nodeIcon(node: ReactNode): IconParam {
	const Glyph: IconComponent = () => <>{node}</>;
	return { icon: Glyph };
}

function TabStrip({ tabsKey }: { tabsKey: NodeKey }): ReactNode {
	const [editor] = useLexicalComposerContext();
	const editable = useLexicalEditable();
	const t = useEditorT();
	const store = tabsActiveStore(editor);
	const [panes, setPanes] = useState<PaneInfo[]>(() => readPanes(editor, tabsKey));
	const [renaming, setRenaming] = useState<NodeKey | null>(null);
	useSyncExternalStore(
		(cb) => store.subscribe(cb),
		() => store.snapshot(),
	);

	useEffect(
		() =>
			editor.registerUpdateListener(() => {
				const next = readPanes(editor, tabsKey);
				setPanes((prev) => (samePanes(prev, next) ? prev : next));
			}),
		[editor, tabsKey],
	);

	const keys = panes.map((p) => p.key);
	const active = resolveActivePane(store.get(tabsKey), keys);
	const activeIndex = Math.max(0, active ? keys.indexOf(active) : 0);

	const select = useCallback(
		(index: number) => {
			const pane = keys[index];
			if (pane) store.set(tabsKey, pane);
		},
		[keys, store, tabsKey],
	);

	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Horizontal,
		count: panes.length,
		activeIndex,
		onActiveIndexChange: select,
		onActivate: select,
		role: "tablist",
		itemRole: "tab",
	});

	const run = (fn: () => unknown): void => {
		editor.update(() => {
			const next = fn();
			if (typeof next === "string") store.set(tabsKey, next);
		});
	};

	const addTab = (): void => run(() => $addTab(tabsKey, defaultTabTitle(t, panes.length)));

	const openMenu = (anchor: HTMLElement, paneKey: NodeKey, index: number): void => {
		const items: ContextMenuItem[] = [
			{
				id: "rename",
				label: t("editor.tabs.rename"),
				icon: nodeIcon(<RenameIcon />),
				shortcut: RENAME_START_CHORD,
				onSelect: () => setRenaming(paneKey),
			},
			{
				id: "move-left",
				label: t("editor.tabs.moveLeft"),
				icon: nodeIcon(<ArrowLeftIcon />),
				disabled: index === 0,
				onSelect: () => run(() => $moveTab(paneKey, -1)),
			},
			{
				id: "move-right",
				label: t("editor.tabs.moveRight"),
				icon: nodeIcon(<ArrowRightIcon />),
				disabled: index === panes.length - 1,
				onSelect: () => run(() => $moveTab(paneKey, 1)),
			},
			{ id: "divider", label: "", divider: true },
			{
				id: "delete",
				label: t("editor.tabs.delete"),
				icon: nodeIcon(<TrashIcon />),
				destructive: true,
				onSelect: () => run(() => $deleteTab(paneKey)),
			},
		];
		const rect = anchor.getBoundingClientRect();
		openContextMenu({ x: rect.right, y: rect.bottom }, items, {
			anchor,
			align: MenuAlign.End,
			menuLabel: t("editor.tabs.menu"),
		});
	};

	return (
		<div className="bs-tabs__bar">
			<div {...containerProps} className="bs-tabs__list" aria-label={t("editor.tabs.region")}>
				{panes.map((pane, index) => {
					const title = pane.title || defaultTabTitle(t, index);
					const isActive = pane.key === active;
					if (renaming === pane.key && editable) {
						return (
							<TabRenameInput
								key={pane.key}
								initial={pane.title}
								label={t("editor.tabs.renameLabel")}
								onDone={(value, fromKeyboard) => {
									setRenaming(null);
									if (value !== null) run(() => $renameTab(pane.key, value));
									if (fromKeyboard) {
										requestAnimationFrame(() => document.getElementById(tabDomId(pane.key))?.focus());
									}
								}}
							/>
						);
					}
					return (
						<button
							key={pane.key}
							type="button"
							{...getItemProps(index)}
							id={tabDomId(pane.key)}
							aria-controls={tabPanelDomId(pane.key)}
							className="bs-tabs__tab"
							data-active={isActive}
							onClick={() => select(index)}
							onDoubleClick={() => editable && setRenaming(pane.key)}
							onKeyDown={(event) => {
								if (!editable || !matchesChord(event.nativeEvent, RENAME_START_CHORD)) return;
								event.preventDefault();
								setRenaming(pane.key);
							}}
							onContextMenu={(event) => {
								if (!editable) return;
								event.preventDefault();
								openMenu(event.currentTarget, pane.key, index);
							}}
						>
							{title}
						</button>
					);
				})}
			</div>
			{editable && active && (
				<button
					type="button"
					className="bs-tabs__action"
					aria-label={t("editor.tabs.menu")}
					data-bs-tooltip={t("editor.tabs.menu")}
					aria-haspopup="menu"
					onClick={(event) => openMenu(event.currentTarget, active, activeIndex)}
				>
					<MoreIcon />
				</button>
			)}
			{editable && (
				<button
					type="button"
					className="bs-tabs__action"
					aria-label={t("editor.tabs.add")}
					data-bs-tooltip={t("editor.tabs.add")}
					onClick={addTab}
				>
					<PlusIcon />
				</button>
			)}
		</div>
	);
}

function TabRenameInput({
	initial,
	label,
	onDone,
}: {
	initial: string;
	label: string;
	onDone: (value: string | null, fromKeyboard: boolean) => void;
}): ReactNode {
	const [value, setValue] = useState(initial);
	const ref = useRef<HTMLInputElement>(null);
	const done = useRef(false);
	useEffect(() => {
		ref.current?.focus();
		ref.current?.select();
	}, []);
	const finish = (next: string | null, fromKeyboard = false): void => {
		if (done.current) return;
		done.current = true;
		onDone(next, fromKeyboard);
	};
	return (
		<input
			ref={ref}
			className="bs-tabs__rename bs-input bs-input--sm"
			aria-label={label}
			value={value}
			onChange={(event) => setValue(event.target.value)}
			onBlur={() => finish(value)}
			onKeyDown={(event) => {
				const native = event.nativeEvent;
				if (RENAME_COMMIT_CHORDS.some((c) => matchesChord(native, c))) {
					event.preventDefault();
					finish(value, true);
				} else if (RENAME_CANCEL_CHORDS.some((c) => matchesChord(native, c))) {
					event.preventDefault();
					finish(null, true);
				}
			}}
		/>
	);
}
