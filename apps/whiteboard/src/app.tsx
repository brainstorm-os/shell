/**
 * Whiteboard app — React chrome (9.17.21, all-apps-React track).
 *
 * The canvas (draw loop, selection model, connector / node rendering,
 * freehand / primitive drawing, pointer-capture interactions) is the
 * imperative `WhiteboardEngine` mounted behind a ref. Everything around it —
 * the `.app-header` (object ⋯ menu LAST), the Add / Style / Arrange / Export
 * menus (all through fancy-menus), the bottom-centre authoring toolbar, the
 * floating zoom controls, the left board-list sidebar, the layers-panel
 * toggle — is React. The engine fills host divs React owns (canvas / layers /
 * board-list); the React tree owns the chrome and re-renders from the engine's
 * `subscribe()` snapshot.
 */

import "@brainstorm/sdk/app-theme.css";
import { useVaultEntities } from "@brainstorm/react-yjs";
import type { VaultEntitiesService } from "@brainstorm/sdk-types";
import { createEntityIconElement } from "@brainstorm/sdk/entity-icon";
import { SaveDispositionKind, svgToPng, textToBytes } from "@brainstorm/sdk/export-file";
import {
	type ExportFormatSpec,
	ExportOptionKind,
	type ExportSelectOption,
	openExportPopover,
} from "@brainstorm/sdk/export-popover";
import { LockButton } from "@brainstorm/sdk/lock-button";
import { MenuAlign } from "@brainstorm/sdk/menus";
import { NavButtons, type NavHistory } from "@brainstorm/sdk/nav-history";
import {
	ObjectMenuMoreButton,
	ObjectMenuTrigger,
	openAnchoredMenu,
} from "@brainstorm/sdk/object-menu";
import { PanelSide, PanelToggleButton } from "@brainstorm/sdk/panel-toggle";
import { Searchbar } from "@brainstorm/sdk/searchbar";
import {
	type ReactElement,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import {
	type ChromeSnapshot,
	ToolId,
	type WhiteboardEngine,
	createWhiteboardEngine,
} from "./engine";
import { type WhiteboardMessageKey, createT } from "./i18n/t";
import { AlignKind, DistributeAxis } from "./logic/align";
import { BOARD_TEMPLATES } from "./logic/templates";
import { WhiteboardExportFormat } from "./logic/whiteboard-export";
import { ZOrderOp } from "./logic/z-order";
import { getBrainstorm } from "./storage/runtime";
import { ShapeKind } from "./types/node";
import { WhiteboardIcon, iconParam } from "./ui/icons";
import { WbIcon } from "./ui/icons-react";

const t = createT();

const EXPORT_CONFIRM_MS = 1600;

type ConfirmState = { key: WhiteboardMessageKey; ok: boolean } | null;

/** Board title with in-place rename (F-198): double-click → input → Enter /
 *  blur commits, Escape cancels. */
function BoardTitle({
	name,
	canRename,
	onCommit,
}: {
	name: string;
	canRename: boolean;
	onCommit: (next: string) => void;
}): ReactElement {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(name);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (editing && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [editing]);

	const begin = useCallback(() => {
		if (!canRename) return;
		setDraft(name);
		setEditing(true);
	}, [canRename, name]);

	const commit = useCallback(() => {
		setEditing(false);
		const next = draft.trim();
		if (next) onCommit(next);
	}, [draft, onCommit]);

	if (editing) {
		return (
			<input
				ref={inputRef}
				className="whiteboard__board-name-input"
				value={draft}
				aria-label={t("whiteboard.board.rename.aria")}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				// keyboard-exempt: input-local rename commit/cancel — Enter commits the board
				// name, Escape cancels; field-scoped, not an app shortcut.
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						commit();
					} else if (e.key === "Escape") {
						e.preventDefault();
						setEditing(false);
					}
				}}
			/>
		);
	}

	return (
		<span
			className="app-header__title whiteboard__board-name"
			title={t("whiteboard.board.rename.hint")}
			onDoubleClick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				begin();
			}}
		>
			{name}
		</span>
	);
}

/** Renders the board's own universal icon (or nothing) into a clickable
 *  button — the entity icon is an imperative SDK element, so it's mounted
 *  into a ref host. */
function BoardIconButton({
	icon,
	onPick,
}: {
	icon: ChromeSnapshot["boardIcon"];
	onPick: () => void;
}): ReactElement | null {
	const hostRef = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const el = createEntityIconElement(icon ?? null, { size: 16 });
		host.replaceChildren();
		if (el) {
			el.classList.add("whiteboard__board-icon");
			host.appendChild(el);
		}
	}, [icon]);

	if (!icon) return null;

	return (
		<button
			type="button"
			className="whiteboard__board-icon-btn"
			data-bs-tooltip={t("whiteboard.board.icon.change")}
			aria-label={t("whiteboard.board.icon.change")}
			onClick={onPick}
		>
			<span ref={hostRef} />
		</button>
	);
}

/** A header icon-button that opens a fancy-menu anchored to itself.
 *  Right-positioned header triggers right-align their menu (`MenuAlign.End`)
 *  per the cross-app anchoring convention. */
function HeaderMenuButton({
	glyph,
	label,
	disabled,
	items,
	testId,
}: {
	glyph: WhiteboardIcon;
	label: string;
	disabled?: boolean;
	items: () => Parameters<typeof openAnchoredMenu>[1];
	testId?: string;
}): ReactElement {
	const ref = useRef<HTMLButtonElement>(null);
	const onClick = useCallback(() => {
		const el = ref.current;
		if (!el || disabled) return;
		const r = el.getBoundingClientRect();
		openAnchoredMenu({ x: r.left, y: r.bottom + 4 }, items(), {
			menuLabel: label,
			anchor: el,
			align: MenuAlign.End,
		});
	}, [disabled, items, label]);
	return (
		<button
			ref={ref}
			type="button"
			className="whiteboard__hdr-btn"
			data-bs-tooltip={label}
			aria-label={label}
			aria-haspopup="menu"
			aria-disabled={disabled ? "true" : undefined}
			data-testid={testId}
			onClick={onClick}
		>
			<WbIcon glyph={glyph} />
		</button>
	);
}

export function WhiteboardApp(): ReactElement {
	const rootRef = useRef<HTMLElement>(null);
	const canvasHostRef = useRef<HTMLDivElement>(null);
	const layersHostRef = useRef<HTMLDivElement>(null);
	const navListRef = useRef<HTMLDivElement>(null);
	const exportBtnRef = useRef<HTMLButtonElement>(null);
	const engineRef = useRef<WhiteboardEngine | null>(null);
	const [confirm, setConfirm] = useState<ConfirmState>(null);
	const [navQuery, setNavQuery] = useState("");
	// In-app back/forward — Location is the open board id. The engine owns the
	// history (it pushes onto it on every user board open) and the actual
	// prev/next-board application; the header NavButtons subscribe to that same
	// instance for live disabled state. Held in state so the buttons render
	// once the engine (created in the mount effect) exists.
	const [boardNav, setBoardNav] = useState<NavHistory<string> | null>(null);
	const confirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => {
		const root = rootRef.current;
		const canvas = canvasHostRef.current;
		const layers = layersHostRef.current;
		const navList = navListRef.current;
		if (!root || !canvas || !layers || !navList) return;
		const engine = createWhiteboardEngine({ root, canvas, layers, navList });
		engineRef.current = engine;
		setBoardNav(engine.boardNav());
		engine.start();
		return () => {
			engine.dispose();
			engineRef.current = null;
			setBoardNav(null);
		};
	}, []);

	const subscribe = useCallback((listener: () => void) => {
		const engine = engineRef.current;
		if (!engine) return () => {};
		return engine.subscribe(listener);
	}, []);
	const getSnapshot = useCallback((): ChromeSnapshot | null => {
		return engineRef.current?.getSnapshot() ?? null;
	}, []);
	const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

	const eng = useCallback((): WhiteboardEngine | null => engineRef.current, []);

	// Board-list reactivity through the shared stack (NO raw `vaultEntities.
	// onChange` loop). `useVaultEntities` returns a new snapshot reference only
	// when the vault content actually changed (version-aware `vaultSnapshotEquals`
	// short-circuit + coalescing live in the hook); a cross-app write or a dev
	// reseed therefore re-reads the boards into the engine so a freshly-seeded
	// board appears without a manual reload.
	// The app's runtime types a narrowed `vaultEntities` (no `queryPattern`,
	// which the board-list reactivity never uses); the shared `useVaultEntities`
	// hook owns the subscription + coalescing, so this hands it the live service
	// (cast to the sdk-types shape) rather than hand-rolling a change loop.
	const vaultService = useMemo(
		() => (getBrainstorm()?.services?.vaultEntities ?? null) as VaultEntitiesService | null,
		[],
	);
	const vault = useVaultEntities(vaultService);
	// Board-level read-only lock — the open board's synced `locked` property.
	const boardLocked = snap?.boardId
		? vault.entities.some((e) => e.id === snap.boardId && e.properties.locked === true)
		: false;
	useEffect(() => {
		eng()?.setReadonly(boardLocked);
	}, [boardLocked, eng]);
	const toggleBoardLock = useCallback(() => {
		const id = snap?.boardId;
		if (!id) return;
		const update = getBrainstorm()?.services?.entities?.update;
		void update?.(id, { locked: !boardLocked });
	}, [snap?.boardId, boardLocked]);
	const seenVault = useRef<typeof vault | null>(null);
	useEffect(() => {
		// `useVaultEntities` returns a new snapshot reference only on a real
		// content change; the first one is the initial load (the engine's
		// own `ready` handler already paints it), so skip it and refresh on
		// every subsequent change.
		const prev = seenVault.current;
		seenVault.current = vault;
		if (prev === null) return;
		eng()?.refreshBoards();
	}, [vault, eng]);

	const flashConfirm = useCallback((key: WhiteboardMessageKey, ok = true): void => {
		clearTimeout(confirmTimer.current);
		setConfirm({ key, ok });
		confirmTimer.current = setTimeout(() => setConfirm(null), EXPORT_CONFIRM_MS);
	}, []);

	useEffect(() => () => clearTimeout(confirmTimer.current), []);

	const copyExport = useCallback(
		(format: WhiteboardExportFormat): void => {
			const text = eng()?.exportText(format) ?? "";
			void navigator.clipboard
				.writeText(text)
				.then(() => flashConfirm("whiteboard.export.copied"))
				.catch(() => flashConfirm("whiteboard.export.failed", false));
		},
		[eng, flashConfirm],
	);

	const saveAs = useCallback(
		(extension: string, filterName: string, encode: () => Uint8Array | Promise<Uint8Array>): void => {
			void eng()
				?.saveBoardAsFile({
					labelKey: "whiteboard.export.saved",
					extension,
					filterName,
					encode,
				})
				.then((result) => {
					if (result.kind === SaveDispositionKind.Saved) flashConfirm("whiteboard.export.saved");
					else if (result.kind === SaveDispositionKind.Failed)
						flashConfirm("whiteboard.export.saveFailed", false);
				});
		},
		[eng, flashConfirm],
	);

	const addItems = useCallback(() => {
		const e = eng();
		const rows: Parameters<typeof openAnchoredMenu>[1] = [
			{
				label: t("whiteboard.add.sticky"),
				icon: iconParam(WhiteboardIcon.Sticky),
				onSelect: () => e?.createSticky(),
			},
			{
				label: t("whiteboard.add.text"),
				icon: iconParam(WhiteboardIcon.Text),
				onSelect: () => e?.createText(),
			},
			{
				label: t("whiteboard.add.rectangle"),
				icon: iconParam(WhiteboardIcon.Rectangle),
				onSelect: () => e?.createRectangle(),
			},
			{
				label: t("whiteboard.add.ellipse"),
				icon: iconParam(WhiteboardIcon.Ellipse),
				onSelect: () => e?.createEllipse(),
			},
			{
				label: t("whiteboard.add.triangle"),
				icon: iconParam(WhiteboardIcon.Triangle),
				onSelect: () => e?.createShape(ShapeKind.Triangle),
			},
			{
				label: t("whiteboard.add.diamond"),
				icon: iconParam(WhiteboardIcon.Diamond),
				onSelect: () => e?.createShape(ShapeKind.Diamond),
			},
			{
				label: t("whiteboard.add.line"),
				icon: iconParam(WhiteboardIcon.Line),
				onSelect: () => e?.createShape(ShapeKind.Line),
			},
			{
				label: t("whiteboard.add.arrow"),
				icon: iconParam(WhiteboardIcon.Arrow),
				onSelect: () => e?.createShape(ShapeKind.Arrow),
			},
			{
				label: t("whiteboard.add.frame"),
				icon: iconParam(WhiteboardIcon.Frame),
				onSelect: () => e?.createFrame(),
			},
			{
				label: t("whiteboard.add.group"),
				icon: iconParam(WhiteboardIcon.Group),
				onSelect: () => e?.createGroupFromSelection(),
			},
		];
		if (e?.hasFilesService()) {
			rows.push({
				label: t("whiteboard.add.image"),
				icon: iconParam(WhiteboardIcon.Image),
				onSelect: () => void e.placeImageFromFile(),
			});
		}
		if (e?.hasVaultEntities()) {
			rows.push({
				label: t("whiteboard.add.embed"),
				icon: iconParam(WhiteboardIcon.Embed),
				onSelect: () => {
					const anchor = document.activeElement;
					void e.pickEntityToEmbed(anchor instanceof HTMLElement ? anchor : document.body);
				},
			});
		}
		return rows;
	}, [eng]);

	const styleItems = useCallback(() => eng()?.styleMenuItems() ?? [], [eng]);

	const arrangeItems = useCallback(() => {
		const e = eng();
		return [
			{ label: t("whiteboard.arrange.alignLeft"), onSelect: () => e?.alignSelection(AlignKind.Left) },
			{
				label: t("whiteboard.arrange.alignCenterX"),
				onSelect: () => e?.alignSelection(AlignKind.CenterX),
			},
			{
				label: t("whiteboard.arrange.alignRight"),
				onSelect: () => e?.alignSelection(AlignKind.Right),
			},
			{ label: t("whiteboard.arrange.alignTop"), onSelect: () => e?.alignSelection(AlignKind.Top) },
			{
				label: t("whiteboard.arrange.alignMiddleY"),
				onSelect: () => e?.alignSelection(AlignKind.MiddleY),
			},
			{
				label: t("whiteboard.arrange.alignBottom"),
				onSelect: () => e?.alignSelection(AlignKind.Bottom),
			},
			{
				label: t("whiteboard.arrange.distributeH"),
				onSelect: () => e?.distributeSelection(DistributeAxis.Horizontal),
			},
			{
				label: t("whiteboard.arrange.distributeV"),
				onSelect: () => e?.distributeSelection(DistributeAxis.Vertical),
			},
			{ label: t("whiteboard.arrange.toFront"), onSelect: () => e?.applyZOrder(ZOrderOp.ToFront) },
			{ label: t("whiteboard.arrange.forward"), onSelect: () => e?.applyZOrder(ZOrderOp.Forward) },
			{ label: t("whiteboard.arrange.backward"), onSelect: () => e?.applyZOrder(ZOrderOp.Backward) },
			{ label: t("whiteboard.arrange.toBack"), onSelect: () => e?.applyZOrder(ZOrderOp.ToBack) },
			{ label: t("whiteboard.arrange.lock"), onSelect: () => e?.setSelectionLocked(true) },
			{ label: t("whiteboard.arrange.unlock"), onSelect: () => e?.setSelectionLocked(false) },
		];
	}, [eng]);

	// One "Export" affordance through the shared popover (same chrome as every
	// app): pick a format (SVG / JSON / PNG), and for the text formats a
	// Save-to-file ↔ Copy-to-clipboard destination. PNG is save-only (binary).
	const openWhiteboardExport = useCallback(() => {
		const e = eng();
		if (!e) return;
		const canSave = e.hasFilesService();
		const destination: ExportSelectOption = {
			kind: ExportOptionKind.Select,
			id: "destination",
			label: t("whiteboard.export.destination"),
			default: canSave ? "save" : "copy",
			choices: canSave
				? [
						{ value: "save", label: t("whiteboard.export.toFile") },
						{ value: "copy", label: t("whiteboard.export.toClipboard") },
					]
				: [{ value: "copy", label: t("whiteboard.export.toClipboard") }],
		};
		const formats: ExportFormatSpec[] = [
			{ id: WhiteboardExportFormat.Svg, label: t("whiteboard.export.fmtSvg"), options: [destination] },
			{
				id: WhiteboardExportFormat.Json,
				label: t("whiteboard.export.fmtJson"),
				options: [destination],
			},
		];
		// PNG is rasterized from the SVG (no WhiteboardExportFormat enum value) and
		// is save-only — binary can't go to the clipboard here.
		if (canSave) formats.push({ id: "png", label: t("whiteboard.export.fmtPng") });
		openExportPopover({
			spec: { formats },
			labels: {
				title: t("whiteboard.export.menu"),
				formatLegend: t("whiteboard.export.formatLegend"),
				exportAction: t("whiteboard.export.action"),
				cancel: t("whiteboard.export.cancel"),
			},
			onExport: ({ formatId, values }) => {
				if (formatId === "png") {
					saveAs("png", "PNG", () => svgToPng(e.exportText(WhiteboardExportFormat.Svg)));
					return;
				}
				const fmt = formatId as WhiteboardExportFormat;
				const ext = fmt === WhiteboardExportFormat.Svg ? "svg" : "json";
				const name = fmt === WhiteboardExportFormat.Svg ? "SVG" : "JSON";
				if (values.destination === "save") {
					saveAs(ext, name, () => textToBytes(e.exportText(fmt)));
				} else {
					copyExport(fmt);
				}
			},
		});
	}, [eng, copyExport, saveAs]);

	const newBoardItems = useCallback(
		() =>
			BOARD_TEMPLATES.map((template) => ({
				label: t(`whiteboard.template.${template}`),
				onSelect: () => eng()?.createNewBoard(template),
			})),
		[eng],
	);

	const boardContext = useCallback(() => eng()?.boardContext() ?? null, [eng]);

	const canStyle = snap?.canStyle ?? false;
	const navOpen = snap?.navOpen ?? true;
	const tool = snap?.tool;
	const exportLabel = confirm ? t(confirm.key) : t("whiteboard.export.menu");

	return (
		<>
			<header className="app-header">
				<div className="app-header__left">
					{boardNav ? (
						<NavButtons history={boardNav} onNavigate={(id) => eng()?.applyBoardLocation(id)} />
					) : null}
					<ObjectMenuTrigger
						context={boardContext}
						moreActionsLabel={t("whiteboard.menu.more")}
						className="whiteboard__board-name-row"
						noMoreButton
					>
						<BoardIconButton icon={snap?.boardIcon ?? null} onPick={() => eng()?.changeBoardIcon()} />
						<BoardTitle
							name={snap?.boardName ?? ""}
							canRename={Boolean(snap?.boardId)}
							onCommit={(next) => eng()?.renameBoard(next)}
						/>
					</ObjectMenuTrigger>
				</div>
				<div className="app-header__right">
					<HeaderMenuButton
						glyph={WhiteboardIcon.Plus}
						label={t("whiteboard.nav.new")}
						items={newBoardItems}
						testId="whiteboard-new-board"
					/>
					<HeaderMenuButton
						glyph={WhiteboardIcon.Shapes}
						label={t("whiteboard.add.menu")}
						disabled={boardLocked}
						items={addItems}
					/>
					<HeaderMenuButton
						glyph={WhiteboardIcon.Style}
						label={canStyle ? t("whiteboard.style.menu") : t("whiteboard.style.menuDisabled")}
						disabled={!canStyle || boardLocked}
						items={styleItems}
					/>
					<HeaderMenuButton
						glyph={WhiteboardIcon.Arrange}
						label={t("whiteboard.arrange.menu")}
						disabled={boardLocked}
						items={arrangeItems}
					/>
					<button
						ref={exportBtnRef}
						type="button"
						className={`whiteboard__hdr-btn${confirm ? (confirm.ok ? " is-success" : " is-error") : ""}`}
						data-bs-tooltip={exportLabel}
						aria-label={exportLabel}
						aria-haspopup="dialog"
						onClick={openWhiteboardExport}
					>
						<WbIcon glyph={confirm?.ok ? WhiteboardIcon.Check : WhiteboardIcon.Export} />
					</button>
					<span className="whiteboard__hdr-sep" aria-hidden="true" />
					<button
						type="button"
						className="whiteboard__hdr-btn"
						data-bs-tooltip={t("whiteboard.layers.toggle")}
						aria-label={t("whiteboard.layers.toggle")}
						aria-pressed={eng()?.isLayersOpen() ? "true" : "false"}
						onClick={() => eng()?.setLayersOpen(!eng()?.isLayersOpen())}
					>
						<WbIcon glyph={WhiteboardIcon.Layers} />
					</button>
					<PanelToggleButton
						side={PanelSide.Left}
						open={navOpen}
						onClick={() => eng()?.toggleNav()}
						labels={{ show: t("whiteboard.nav.show"), hide: t("whiteboard.nav.hide") }}
					/>
					{snap?.boardId ? (
						<LockButton
							locked={boardLocked}
							onToggle={toggleBoardLock}
							lockLabel={t("whiteboard.board.lock")}
							unlockLabel={t("whiteboard.board.unlock")}
						/>
					) : null}
					<ObjectMenuMoreButton context={boardContext} moreActionsLabel={t("whiteboard.menu.more")} />
				</div>
			</header>
			<main
				className="whiteboard"
				id="whiteboard-root"
				ref={rootRef}
				data-nav-open={navOpen ? "true" : "false"}
			>
				<aside className="whiteboard__nav" id="whiteboard-nav" aria-label={t("whiteboard.nav.aria")}>
					<div className="whiteboard__search">
						<Searchbar
							value={navQuery}
							placeholder={t("whiteboard.nav.search.placeholder")}
							clearLabel={t("whiteboard.nav.search.clear")}
							onChange={(next) => {
								setNavQuery(next);
								eng()?.setNavQuery(next);
							}}
						/>
					</div>
					<div className="whiteboard__nav-list" aria-label={t("whiteboard.nav.aria")} ref={navListRef} />
				</aside>
				<div className="whiteboard__canvas-host" ref={canvasHostRef}>
					<WhiteboardToolbar tool={tool} onSetTool={(next) => eng()?.setTool(next)} />
					<div className="whiteboard__zoom">
						<button
							type="button"
							className="whiteboard__zoom-btn"
							data-bs-tooltip={t("whiteboard.zoom.in")}
							aria-label={t("whiteboard.zoom.in")}
							onClick={() => eng()?.zoomBy(1.1)}
						>
							<WbIcon glyph={WhiteboardIcon.Plus} />
						</button>
						<button
							type="button"
							className="whiteboard__zoom-level"
							title={t("whiteboard.zoom.resetLevel")}
							aria-label={t("whiteboard.zoom.resetLevel")}
							onClick={() => eng()?.zoomTo(1)}
						>
							{`${snap?.zoomPercent ?? 100}%`}
						</button>
						<button
							type="button"
							className="whiteboard__zoom-btn"
							data-bs-tooltip={t("whiteboard.zoom.out")}
							aria-label={t("whiteboard.zoom.out")}
							onClick={() => eng()?.zoomBy(1 / 1.1)}
						>
							<WbIcon glyph={WhiteboardIcon.Minus} />
						</button>
						<span className="whiteboard__zoom-sep" aria-hidden="true" />
						<button
							type="button"
							className="whiteboard__zoom-fit"
							data-bs-tooltip={t("whiteboard.zoom.resetView")}
							aria-label={t("whiteboard.zoom.resetView")}
							onClick={() => eng()?.resetCamera()}
						>
							<WbIcon glyph={WhiteboardIcon.Reset} />
						</button>
					</div>
					<div className="whiteboard__layers-host" ref={layersHostRef} />
				</div>
				<div className="whiteboard__hint">{t("whiteboard.hint")}</div>
			</main>
		</>
	);
}

const TOOL_ITEMS: ReadonlyArray<{ id: ToolId; icon: WhiteboardIcon; label: WhiteboardMessageKey }> =
	[
		{ id: ToolId.Select, icon: WhiteboardIcon.Pointer, label: "whiteboard.tools.select" },
		{ id: ToolId.Sticky, icon: WhiteboardIcon.Sticky, label: "whiteboard.tools.sticky" },
		{ id: ToolId.Text, icon: WhiteboardIcon.Text, label: "whiteboard.tools.text" },
		{ id: ToolId.Frame, icon: WhiteboardIcon.Frame, label: "whiteboard.tools.frame" },
		{ id: ToolId.Pen, icon: WhiteboardIcon.Pen, label: "whiteboard.tools.pen" },
	];

function WhiteboardToolbar({
	tool,
	onSetTool,
}: {
	tool: ToolId | undefined;
	onSetTool: (next: ToolId) => void;
}): ReactElement {
	return (
		// kbn-roles-exempt: toolbar items are focusable <button>s (Tab+Enter operable); arrow-key roving is a future useRegionNavigation enhancement.
		<div className="whiteboard__tools" role="toolbar" aria-label={t("whiteboard.tools.aria")}>
			{TOOL_ITEMS.map((item) => (
				<button
					key={item.id}
					type="button"
					className="whiteboard__tool"
					data-bs-tooltip={t(item.label)}
					aria-label={t(item.label)}
					aria-pressed={item.id === tool ? "true" : "false"}
					onClick={() => onSetTool(item.id)}
				>
					<WbIcon glyph={item.icon} />
				</button>
			))}
		</div>
	);
}
