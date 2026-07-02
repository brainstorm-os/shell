/**
 * Graph app — React chrome (9.13.16 Stages 2 + 3, all-apps-React track).
 *
 * The canvas core (Pixi lifecycle, rAF/sim loop, pointer/drag/hover/pan/zoom,
 * scene build, visibility-pause, `__graphProbe`, persistence, hover-preview +
 * node object-menu) is the imperative `GraphCanvasController` mounted behind a
 * ref. Everything around it — the `.app-header` (Graph's allowed delta is the
 * absolute overlay positioning; object ⋯ menu LAST through fancy-menus), the
 * sidebar pattern editor (subjects / edges / where-builder / type / enum / hops
 * pickers), the force sliders, the settings toggles, the legend, the scrubber +
 * history popover + density histogram, the local badge, the match summary, the
 * status pill, the zoom controls — is React, re-rendering from the controller's
 * `subscribe()` snapshot.
 *
 * Stage 3: the vault data subscription runs through the shared
 * `useVaultEntities` hook (NO raw `vaultEntities.onChange` loop in the
 * controller) and is fed into the controller via `setVaultData`; the
 * `queryPattern` server-side resolve + the no-refit-on-change behaviour are
 * preserved inside the controller.
 *
 * The hover-preview card + edge-tooltip are canvas-owned popovers the
 * controller fills imperatively (driven by hover); React renders their empty
 * host elements (with the exact ids/classes the controller queries) and the
 * controller owns their content.
 */

import "@brainstorm/sdk/app-theme.css";
import "./types"; // type-only side-effect import keeps the surface in the build graph.
import type { EntityCommentsServices } from "@brainstorm/editor";
import { useVaultEntities } from "@brainstorm/react-yjs";
import type { VaultEntitiesService } from "@brainstorm/sdk-types";
import { Checkbox } from "@brainstorm/sdk/checkbox";
import {
	SaveDispositionKind,
	failureDetail,
	requestSaveBytes,
	suggestedFilename,
	svgToPng,
	textToBytes,
} from "@brainstorm/sdk/export-file";
import {
	type ExportFormatSpec,
	ExportOptionKind,
	type ExportSelectOption,
	openExportPopover,
} from "@brainstorm/sdk/export-popover";
import { IconName } from "@brainstorm/sdk/icon";
import { MenuAlign, mountMenuHost } from "@brainstorm/sdk/menus";
import {
	type AnchoredMenuItem,
	type ObjectMenuExtraItem,
	type ObjectMenuRuntime,
	closeObjectMenu,
	openAnchoredMenu,
	openObjectMenu,
} from "@brainstorm/sdk/object-menu";
import { attachResizable } from "@brainstorm/sdk/resizable";
import { SelectMenu } from "@brainstorm/sdk/select-menu";
import {
	type ReactElement,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import {
	type CanvasSnapshot,
	type GraphCanvasController,
	type GraphRuntime,
	SidebarMode,
	createGraphCanvasController,
} from "./graph-canvas-controller";
import { plural, t } from "./i18n/t";
import { EXPORT_EXTENSIONS, GraphExportFormat, exportGraph, toSVG } from "./logic/graph-export";
import { bucketTimestamps, cutoffBucketIndex } from "./logic/history-buckets";
import { legendCounts } from "./logic/legend-stats";
import { LinkCategory, linkCategoryLabel } from "./logic/link-reason";
import {
	LocalDirection,
	MAX_LOCAL_DEPTH,
	MIN_LOCAL_DEPTH,
	clampLocalDepth,
} from "./logic/local-scope";
import {
	type TypeOption,
	addEdge,
	addSubject,
	availableEntityTypes,
	availableLinkTypes,
	canAddEdge,
	canAddSubject,
	defaultPattern,
	hopsKey,
	hopsOptionsFor,
	parseHopsKey,
	primarySubjectKey,
	removeEdge,
	removeSubject,
	subjectCount,
	typeShortLabel,
	updateEdge,
	updateSubject,
} from "./logic/pattern-edit";
import { PATTERN_TEMPLATES, presentTypeSet, templateAvailable } from "./logic/pattern-templates";
import { validatePattern } from "./logic/pattern-validate";
import { partitionTypeOptions } from "./logic/type-partition";
import {
	WHERE_OPS,
	WhereOp,
	type WhereRow,
	emptyWhereRow,
	isUnaryOp,
	predicateToRows,
	rowsToPredicate,
} from "./logic/where-builder";
import { SelectionInspector } from "./react/selection-inspector";
import { rawNodeLabel } from "./render/node-label";
import { colorForType, edgeColorForCategory, subjectColorsFor } from "./render/scene";
import { GRAPH_TYPE } from "./storage/graph-repository";
import { HistoryReveal } from "./types/graph-view";
import { EdgeDirection, EdgeMatch, type GraphPattern, type Hops } from "./types/pattern";
import type { PropertyPredicate } from "./types/predicate";
import { GraphIcon, type GraphIconName } from "./ui/icons";
import { GIcon } from "./ui/icons-react";

const SCRUBBER_STEPS = 1000;
const HIST_BUCKETS = 40;
const PLAYBACK_SPEEDS = [1, 2, 4, 8, 16] as const;

const REVEAL_CYCLE: readonly HistoryReveal[] = [
	HistoryReveal.Strict,
	HistoryReveal.Eased,
	HistoryReveal.Recent,
];

function revealLabel(reveal: HistoryReveal): string {
	switch (reveal) {
		case HistoryReveal.Strict:
			return t("reveal.strict");
		case HistoryReveal.Recent:
			return t("reveal.recent");
		default:
			return t("reveal.eased");
	}
}

function getRuntime(): GraphRuntime | null {
	return (window as unknown as { brainstorm?: GraphRuntime }).brainstorm ?? null;
}

/* ── Header menu button (anchored fancy-menu) ───────────────────────────── */

function HeaderIconToggle({
	glyph,
	label,
	active,
	onClick,
}: {
	glyph: GraphIconName;
	label: string;
	active: boolean;
	onClick: () => void;
}): ReactElement {
	return (
		<button
			type="button"
			className="header-icon-btn"
			aria-pressed={active}
			aria-label={label}
			data-bs-tooltip={label}
			onClick={onClick}
		>
			<GIcon glyph={glyph} />
		</button>
	);
}

/** A sidebar/toolbar button that opens a fancy-menu anchored to itself. */
function AnchoredMenuButton({
	label,
	className,
	items,
}: {
	label: string;
	className: string;
	items: () => AnchoredMenuItem[];
}): ReactElement {
	const ref = useRef<HTMLButtonElement>(null);
	const onClick = useCallback(() => {
		const el = ref.current;
		if (!el) return;
		const r = el.getBoundingClientRect();
		openAnchoredMenu({ x: r.left, y: r.bottom + 4 }, items(), {
			menuLabel: label,
			anchor: el,
			align: MenuAlign.Start,
		});
	}, [items, label]);
	return (
		<button ref={ref} type="button" className={className} aria-haspopup="menu" onClick={onClick}>
			{label}
		</button>
	);
}

/* ── Type picker (multi-select dropdown via <details>) ──────────────────── */

function TypePicker({
	selected,
	options,
	className,
	onChange,
}: {
	selected: string[];
	options: { type: string; count: number }[];
	className?: string;
	onChange: (next: string[]) => void;
}): ReactElement {
	const selectedSet = new Set(selected);
	const summary =
		selectedSet.size === 0
			? t("type.any")
			: selected.map(typeShortLabel).join(", ") || t("type.someSelected", { count: selectedSet.size });
	return (
		<details className={className ? `type-picker ${className}` : "type-picker"}>
			<summary className="type-picker__summary">{summary}</summary>
			<div className="type-picker__list">
				{options.length === 0 ? (
					<p className="type-picker__empty">{t("type.none")}</p>
				) : (
					options.map((opt) => (
						<div key={opt.type} className="type-picker__option">
							<Checkbox
								label={typeShortLabel(opt.type)}
								checked={selectedSet.has(opt.type)}
								onChange={(checked) => {
									const next = new Set(selectedSet);
									if (checked) next.add(opt.type);
									else next.delete(opt.type);
									onChange([...next]);
								}}
							/>
							<span className="type-picker__count">{opt.count}</span>
						</div>
					))
				)}
			</div>
		</details>
	);
}

/* ── Where editor (property-predicate row builder via <details>) ────────── */

function whereOpLabel(op: WhereOp): string {
	switch (op) {
		case WhereOp.Eq:
			return t("where.op.$eq");
		case WhereOp.Neq:
			return t("where.op.$neq");
		case WhereOp.Contains:
			return t("where.op.$contains");
		case WhereOp.NotContains:
			return t("where.op.$notContains");
		case WhereOp.Gt:
			return t("where.op.$gt");
		case WhereOp.Lt:
			return t("where.op.$lt");
		case WhereOp.Gte:
			return t("where.op.$gte");
		case WhereOp.Lte:
			return t("where.op.$lte");
		case WhereOp.Like:
			return t("where.op.$like");
		case WhereOp.NotLike:
			return t("where.op.$notLike");
		case WhereOp.Exists:
			return t("where.op.$exists");
		default:
			return t("where.op.$empty");
	}
}

function edgeDirLabel(dir: EdgeDirection): string {
	switch (dir) {
		case EdgeDirection.Out:
			return t("edge.dir.out");
		case EdgeDirection.In:
			return t("edge.dir.in");
		default:
			return t("edge.dir.both");
	}
}

function edgeMatchLabel(match: EdgeMatch): string {
	switch (match) {
		case EdgeMatch.Required:
			return t("edge.match.required");
		case EdgeMatch.Optional:
			return t("edge.match.optional");
		default:
			return t("edge.match.forbidden");
	}
}

function WhereEditor({
	subjectName,
	where,
	onChange,
}: {
	subjectName: string;
	where: PropertyPredicate | null;
	onChange: (next: PropertyPredicate | null) => void;
}): ReactElement {
	const decomposed = useMemo(() => predicateToRows(where), [where]);
	const readOnly = !decomposed.editable;
	const [rows, setRows] = useState<WhereRow[]>(() => decomposed.rows.map((r) => ({ ...r })));

	const seenWhere = useRef(where);
	useEffect(() => {
		if (seenWhere.current === where) return;
		seenWhere.current = where;
		setRows(predicateToRows(where).rows.map((r) => ({ ...r })));
	}, [where]);

	const commit = useCallback(
		(next: WhereRow[]) => {
			onChange(rowsToPredicate(next));
		},
		[onChange],
	);

	const activeCount = rows.filter((r) => r.property.trim() !== "").length;
	const summary =
		activeCount > 0 ? t("subject.whereSummary", { count: activeCount }) : t("subject.where");

	return (
		<details className="where-editor">
			<summary className="where-editor__summary">{summary}</summary>
			<div className="where-editor__body">
				{readOnly ? (
					<p className="where-editor__notice">{t("subject.whereReadOnly")}</p>
				) : (
					<>
						{rows.map((row, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: where rows are positional and have no stable id.
							<div className="where-editor__row" key={index}>
								<input
									className="where-editor__prop bs-input bs-input--sm"
									value={row.property}
									placeholder={t("subject.wherePropertyPlaceholder")}
									aria-label={t("subject.wherePropertyAria", { name: subjectName })}
									onChange={(e) => {
										const next = rows.map((r, i) => (i === index ? { ...r, property: e.target.value } : r));
										setRows(next);
										commit(next);
									}}
								/>
								<SelectMenu<WhereOp>
									className="bs-select--sm where-editor__op"
									ariaLabel={t("subject.whereOpAria", { name: subjectName })}
									value={row.op}
									options={WHERE_OPS.map((op) => ({ value: op, label: whereOpLabel(op) }))}
									onChange={(op) => {
										const next = rows.map((r, i) => (i === index ? { ...r, op } : r));
										setRows(next);
										commit(next);
									}}
								/>
								{!isUnaryOp(row.op) ? (
									<input
										className="where-editor__val bs-input bs-input--sm"
										value={row.value}
										placeholder={t("subject.whereValuePlaceholder")}
										aria-label={t("subject.whereValueAria", { name: subjectName })}
										onChange={(e) => {
											const next = rows.map((r, i) => (i === index ? { ...r, value: e.target.value } : r));
											setRows(next);
											commit(next);
										}}
									/>
								) : null}
								<button
									type="button"
									className="where-editor__remove"
									data-bs-tooltip={t("subject.whereRemoveRow")}
									title={rows.length <= 1 ? t("subject.whereRemoveRow") : undefined}
									aria-label={t("subject.whereRemoveRow")}
									disabled={rows.length <= 1}
									onClick={() => {
										let next = rows.filter((_, i) => i !== index);
										if (next.length === 0) next = [emptyWhereRow()];
										setRows(next);
										commit(next);
									}}
								>
									<span className="pattern-icon">
										<GIcon glyph={GraphIcon.Close} />
									</span>
								</button>
							</div>
						))}
						<button
							type="button"
							className="pattern-add where-editor__add"
							onClick={() => setRows([...rows, emptyWhereRow()])}
						>
							<span className="pattern-icon pattern-add__icon">
								<GIcon glyph={GraphIcon.Plus} />
							</span>
							<span>{t("subject.whereAddRow")}</span>
						</button>
					</>
				)}
			</div>
		</details>
	);
}

/* ── Hops label ─────────────────────────────────────────────────────────── */

function hopsLabel(window: Hops): string {
	const [min, max] = window;
	if (min === 1 && max === 1) return t("edge.hops.direct");
	if (min === 1) return t("edge.hops.upTo", { n: max });
	return t("edge.hops.window", { m: min, n: max });
}

/* ── App root ───────────────────────────────────────────────────────────── */

export function GraphApp(): ReactElement {
	const containerRef = useRef<HTMLDivElement>(null);
	const sidebarResizeRef = useRef<HTMLDivElement>(null);
	const controllerRef = useRef<GraphCanvasController | null>(null);
	const [controller, setController] = useState<GraphCanvasController | null>(null);
	const [hydrating, setHydrating] = useState(true);

	useEffect(() => {
		mountMenuHost();
		const container = containerRef.current;
		if (!container) return;
		let disposed = false;
		let made: GraphCanvasController | null = null;
		createGraphCanvasController({ container })
			.then((c) => {
				if (disposed) {
					c.dispose();
					return;
				}
				made = c;
				controllerRef.current = c;
				setController(c);
				c.applySettingsToSvg();
				c.hydrateFromRuntime({
					runtime: getRuntime(),
					clearHydrating: () =>
						requestAnimationFrame(() => requestAnimationFrame(() => setHydrating(false))),
				});
			})
			.catch((error) => {
				// A swallowed init rejection (e.g. renderer/GPU failure) would leave
				// `snap` null forever — blank canvas, dead header buttons, silent
				// console. Surface it instead.
				console.error("[graph] controller initialization failed:", error);
			});
		return () => {
			disposed = true;
			closeObjectMenu();
			made?.dispose();
			controllerRef.current = null;
		};
	}, []);

	// Sidebar resize handle (shared SDK resizable; persisted width on body var).
	useEffect(() => {
		const handle = sidebarResizeRef.current;
		if (!handle) return;
		const resizable = attachResizable({
			handle,
			side: "right",
			defaultWidth: 320,
			min: 240,
			max: 520,
			storageKey: "graph:sidebar-width",
			onWidth: (px) => document.body.style.setProperty("--graph-sidebar-width", `${px}px`),
		});
		return () => resizable.destroy();
	}, []);

	// Depend on `controller` so `useSyncExternalStore` re-subscribes once the
	// async-created controller arrives. With `[]` deps the first subscribe ran
	// while `controllerRef.current` was still null — returning a dead no-op that
	// never rebound — so the controller's `emit()` (sidebar toggles, status,
	// active states) never reached React; the chrome only updated on incidental
	// re-renders. Canvas nodes were unaffected (Pixi paints on its own rAF loop).
	// biome-ignore lint/correctness/useExhaustiveDependencies: `controller` is an intentional re-subscribe trigger — the body reads `controllerRef.current`, but identity must change when the async controller arrives so useSyncExternalStore rebinds.
	const subscribe = useCallback(
		(listener: () => void) => {
			const c = controllerRef.current;
			if (!c) return () => {};
			return c.subscribe(listener);
		},
		[controller],
	);
	const getSnapshot = useCallback((): CanvasSnapshot | null => {
		return controllerRef.current?.getSnapshot() ?? null;
	}, []);
	const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

	// Vault data through the shared reactivity stack (NO raw `vaultEntities.
	// onChange` loop). `useVaultEntities` returns a new snapshot reference only
	// when the vault content actually changed; feed each into the controller,
	// which converts → reshades → resolves the pattern server-side (and fits on
	// the first delivery only). The first reference IS the empty initial value
	// — skip it until real data lands so the first-load bootstrap doesn't run
	// on an empty placeholder.
	const vaultService = useMemo(
		() => (getRuntime()?.services?.vaultEntities ?? null) as VaultEntitiesService | null,
		[],
	);
	const vault = useVaultEntities(vaultService);
	const fedRef = useRef(false);
	useEffect(() => {
		// The controller is created ASYNC — feed on BOTH "vault changed" and
		// "controller arrived". Depending only on `vault` silently dropped the
		// data when `list()` resolved before the controller existed, and a
		// quiet vault never produced another change to retry (empty canvas
		// until any entity changed).
		if (!controller) return;
		// `useVaultEntities` hands back the same EMPTY snapshot reference until
		// the first `list()` resolves; don't consume the first-load fit on the
		// placeholder. Once real data has fed, an empty snapshot is legitimate
		// (the vault genuinely emptied).
		if (!fedRef.current && vault.entities.length === 0 && vault.links.length === 0) return;
		fedRef.current = true;
		controller.setVaultData({ entities: vault.entities, links: vault.links });
	}, [vault, controller]);

	return (
		<>
			<GraphHeader controller={controller} snap={snap} />
			<main
				className="graph-main"
				id="graph-main"
				data-sidebar-mode={snap?.sidebarMode ?? SidebarMode.Filters}
				data-sidebar-collapsed={String(snap?.sidebarCollapsed ?? false)}
				data-hydrating={hydrating ? "true" : undefined}
			>
				<section className="graph-canvas-wrap" id="canvas-wrap" aria-label={t("canvas.wrapAria")}>
					<div className="graph-canvas-container" id="canvas-container" ref={containerRef} />
					<LocalBadge controller={controller} snap={snap} />
					<Legend controller={controller} snap={snap} />
					<div className="zoom-controls" aria-label={t("zoom.in")}>
						<button
							type="button"
							className="bs-btn bs-btn--ghost bs-btn--sm bs-btn--icon"
							aria-label={t("zoom.in")}
							data-bs-tooltip={t("zoom.in")}
							onClick={() => controller?.zoomIn()}
						>
							<GIcon glyph={GraphIcon.Plus} />
						</button>
						<button
							type="button"
							className="bs-btn bs-btn--ghost bs-btn--sm bs-btn--icon"
							aria-label={t("zoom.out")}
							data-bs-tooltip={t("zoom.out")}
							onClick={() => controller?.zoomOut()}
						>
							<GIcon glyph={GraphIcon.Minus} />
						</button>
						<button
							type="button"
							className="bs-btn bs-btn--ghost bs-btn--sm bs-btn--icon"
							aria-label={t("zoom.reset")}
							data-bs-tooltip={t("zoom.reset")}
							onClick={() => controller?.resetCamera()}
						>
							<GIcon glyph={GraphIcon.Reset} />
						</button>
					</div>
				</section>

				<aside
					className="graph-sidebar glass--strong"
					id="graph-sidebar"
					aria-label={t("sidebar.aria")}
				>
					<div
						className="graph-sidebar__resize"
						ref={sidebarResizeRef}
						role="separator"
						aria-orientation="vertical"
						aria-label={t("sidebar.resize")}
						tabIndex={0}
					/>
					{snap?.sidebarMode === SidebarMode.Settings ? (
						<SettingsPanel controller={controller} snap={snap} />
					) : (
						<FiltersPanel controller={controller} snap={snap} />
					)}
				</aside>
			</main>

			<HoverPreviewHost />
			<EdgeTooltipHost />
			{controller && snap ? <GraphSelectionInspector controller={controller} snap={snap} /> : null}
			<HistoryFab controller={controller} snap={snap} />
		</>
	);
}

/* ── Header ─────────────────────────────────────────────────────────────── */

/** The graph-view actions (fit / reset view + layout / export / panels) the
 *  header ⋯ always offers — independent of whether a Graph/v1 entity is bound.
 *  Rendered as object-menu extra items when a record exists, and as the whole
 *  menu when none does (the default global graph). */
function graphViewActions(
	controller: GraphCanvasController,
	toggleSidebar: (mode: SidebarMode) => void,
): ObjectMenuExtraItem[] {
	return [
		{
			id: "fit-to-content",
			label: t("menu.fitToContent"),
			icon: IconName.View,
			run: () => controller.fitToContent(),
		},
		{
			id: "reset-view",
			label: t("menu.resetView"),
			icon: IconName.Reload,
			run: () => controller.resetCamera(),
		},
		{
			id: "reset-layout",
			label: t("menu.resetLayout"),
			icon: IconName.Update,
			run: () => controller.resetLayout(),
		},
		{
			id: "export",
			label: t("menu.export"),
			icon: IconName.Download,
			run: () => openGraphExportPopover(controller),
		},
		{
			id: "open-filters",
			label: t("menu.openFilters"),
			icon: IconName.Search,
			run: () => toggleSidebar(SidebarMode.Filters),
		},
		{
			id: "open-settings",
			label: t("menu.openSettings"),
			icon: IconName.Settings,
			run: () => toggleSidebar(SidebarMode.Settings),
		},
	];
}

function GraphHeaderMenuButton({
	controller,
	record,
	toggleSidebar,
}: {
	controller: GraphCanvasController;
	record: { id: string; name: string } | null;
	toggleSidebar: (mode: SidebarMode) => void;
}): ReactElement {
	const ref = useRef<HTMLButtonElement>(null);

	useEffect(() => closeObjectMenu, []);

	const open = useCallback(() => {
		const el = ref.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const point = { x: rect.left, y: rect.bottom + 4 };
		const items = graphViewActions(controller, toggleSidebar);
		if (record) {
			void openObjectMenu(point, {
				target: { entityId: record.id, entityType: GRAPH_TYPE, label: record.name },
				runtime: getRuntime() as ObjectMenuRuntime,
				labels: {
					open: t("menu.open"),
					pin: t("menu.pin"),
					unpin: t("menu.unpin"),
					menuRegion: t("menu.graphRegion"),
				},
				extraItems: items,
				anchor: el,
				align: MenuAlign.End,
			});
			return;
		}
		// No bound Graph/v1 entity (the default global graph): the ⋯ is still the
		// trailing overflow per the header contract — it just carries only the
		// view actions, opened through the same shared anchored-menu runtime.
		openAnchoredMenu(
			point,
			items.map((item) => ({
				label: item.label,
				onSelect: () => void item.run(),
				...(item.icon ? { icon: item.icon } : {}),
			})),
			{ menuLabel: t("menu.graphRegion"), anchor: el, align: MenuAlign.End },
		);
	}, [controller, record, toggleSidebar]);

	return (
		<button
			ref={ref}
			type="button"
			className="bs-object-menu__more"
			aria-haspopup="menu"
			aria-label={t("menu.graphActions")}
			data-bs-tooltip={t("menu.graphActions")}
			onClick={open}
		>
			<span className="bs-object-menu__more-dot" />
			<span className="bs-object-menu__more-dot" />
			<span className="bs-object-menu__more-dot" />
		</button>
	);
}

function GraphHeader({
	controller,
	snap,
}: {
	controller: GraphCanvasController | null;
	snap: CanvasSnapshot | null;
}): ReactElement {
	const record = controller?.getState().graphRecord ?? null;

	const toggleSidebar = (mode: SidebarMode) => {
		if (!snap) return;
		if (!snap.sidebarCollapsed && snap.sidebarMode === mode) controller?.setSidebar(mode, true);
		else controller?.setSidebar(mode, false);
	};

	const filtersActive = !!snap && !snap.sidebarCollapsed && snap.sidebarMode === SidebarMode.Filters;
	const settingsActive =
		!!snap && !snap.sidebarCollapsed && snap.sidebarMode === SidebarMode.Settings;

	return (
		<header className="app-header">
			<div className="app-header__left">
				<h1 className="app-header__title">{record?.name || t("header.appTitle")}</h1>
			</div>
			<div className="app-header__right">
				<HeaderIconToggle
					glyph={GraphIcon.Path}
					label={t("path.button")}
					active={!!snap?.pathMode}
					onClick={() => controller?.setPathMode(!snap?.pathMode)}
				/>
				<HeaderIconToggle
					glyph={snap?.isPlaying ? GraphIcon.Pause : GraphIcon.Play}
					label={t("header.animate")}
					active={!!snap?.isPlaying}
					onClick={() => controller?.togglePlayback()}
				/>
				<HeaderIconToggle
					glyph={GraphIcon.Filters}
					label={t("header.filters")}
					active={filtersActive}
					onClick={() => toggleSidebar(SidebarMode.Filters)}
				/>
				<HeaderIconToggle
					glyph={GraphIcon.Settings}
					label={t("header.settings")}
					active={settingsActive}
					onClick={() => toggleSidebar(SidebarMode.Settings)}
				/>
				{controller ? <ExportMenuButton controller={controller} /> : null}
				{controller ? (
					<GraphHeaderMenuButton controller={controller} record={record} toggleSidebar={toggleSidebar} />
				) : null}
			</div>
		</header>
	);
}

/* ── Filters panel ──────────────────────────────────────────────────────── */

function ShowToggleChip({
	option,
	checked,
	color,
	onToggle,
}: {
	option: TypeOption;
	checked: boolean;
	color: string;
	onToggle: (checked: boolean) => void;
}): ReactElement {
	return (
		<label className="show-toggle">
			<input
				type="checkbox"
				className="show-toggle__box"
				checked={checked}
				aria-label={t("show.toggle", { type: typeShortLabel(option.type) })}
				onChange={(e) => onToggle(e.target.checked)}
			/>
			<span className="show-toggle__dot" style={{ background: color }} />
			<span className="show-toggle__label">{typeShortLabel(option.type)}</span>
			<span className="show-toggle__count">{option.count}</span>
		</label>
	);
}

function FiltersPanel({
	controller,
	snap,
}: {
	controller: GraphCanvasController | null;
	snap: CanvasSnapshot | null;
}): ReactElement | null {
	if (!controller || !snap) return null;
	const state = controller.getState();
	const pattern = state.pattern;
	const apply = (next: GraphPattern, options: { reseed: boolean } = { reseed: true }) =>
		controller.setPattern(next, options);

	const key = primarySubjectKey(pattern);
	const subject = pattern.subjects[key];
	const selected = new Set(subject?.types ?? []);
	const typeOptions = availableEntityTypes(state.db);
	const { user: userTypes, system: systemTypes } = partitionTypeOptions(typeOptions);
	const toggleType = (type: string, on: boolean) => {
		const next = new Set(selected);
		if (on) next.add(type);
		else next.delete(type);
		apply(updateSubject(pattern, key, { types: [...next] }));
	};

	const presentTypes = presentTypeSet(state.db);
	const templateItems = (): AnchoredMenuItem[] =>
		PATTERN_TEMPLATES.map((template) => {
			const available = templateAvailable(template, presentTypes);
			return {
				label: t(template.nameKey),
				disabled: !available,
				...(available ? {} : { hint: t("templates.unavailable") }),
				onSelect: () => apply(template.build()),
			};
		});

	const validation = validatePattern(pattern);
	const advisory =
		!validation.ok &&
		validation.issues.some(
			(i) => i.code === "subject-empty-types" || i.code === "edge-empty-link-types",
		);

	const subjects = Object.entries(pattern.subjects);
	const subjectColors = subjectColorsFor(Object.keys(pattern.subjects), state.theme);
	const counts = state.scene.matchResult.nodesBySubject;
	const onlyOneSubject = subjectCount(pattern) <= 1;
	const linkOptions = availableLinkTypes(state.db);

	return (
		<div className="graph-sidebar__view graph-sidebar__view--filters" data-mode="filters">
			<section className="sidebar-section">
				<h2>{t("section.show")}</h2>
				<p className="sidebar-section__hint">{t("section.showHint")}</p>
				<div className="show-toggles" id="show-toggles">
					{typeOptions.length === 0 ? (
						<p className="show-toggles__empty">{t("show.empty")}</p>
					) : (
						userTypes.map((opt) => (
							<ShowToggleChip
								key={opt.type}
								option={opt}
								checked={selected.has(opt.type)}
								color={colorForType(opt.type, state.theme)}
								onToggle={(on) => toggleType(opt.type, on)}
							/>
						))
					)}
				</div>
				{systemTypes.length > 0 ? (
					<div className="show-toggles show-toggles--system" id="show-toggles-system">
						<p className="show-toggles__group-label">{t("show.systemGroup")}</p>
						{systemTypes.map((opt) => (
							<ShowToggleChip
								key={opt.type}
								option={opt}
								checked={selected.has(opt.type)}
								color={colorForType(opt.type, state.theme)}
								onToggle={(on) => toggleType(opt.type, on)}
							/>
						))}
					</div>
				) : null}
			</section>

			<section className="sidebar-section">
				<h2>{t("section.matches")}</h2>
				<div className="match-summary" id="match-summary">
					<div className="match-summary__row">
						<span>{t("summary.bindings")}</span>
						<span>{snap.stats.bindings}</span>
					</div>
					<div className="match-summary__row">
						<span>{t("summary.visibleNodes")}</span>
						<span>{snap.stats.visibleNodes}</span>
					</div>
					<div className="match-summary__row">
						<span>{t("summary.visibleEdges")}</span>
						<span>{snap.stats.visibleEdges}</span>
					</div>
				</div>
			</section>

			<details className="sidebar-advanced" id="pattern-advanced">
				<summary className="sidebar-advanced__summary">{t("advanced.summary")}</summary>
				<section className="sidebar-section">
					<h2>{t("section.pattern")}</h2>
					<p className="sidebar-section__hint">{t("section.patternHint")}</p>
					<div className="pattern-toolbar" id="pattern-toolbar">
						<button type="button" className="pattern-reset" onClick={() => apply(defaultPattern())}>
							{t("pattern.reset")}
						</button>
						<AnchoredMenuButton
							label={t("templates.button")}
							className="pattern-reset"
							items={templateItems}
						/>
						{advisory ? <p className="pattern-advisory">{t("pattern.advisory")}</p> : null}
					</div>
				</section>

				<section className="sidebar-section">
					<h2>{t("section.subjects")}</h2>
					<ul className="subject-list" id="subject-list">
						{subjects.map(([name, subj]) => (
							<li key={name} className="subject-list__item">
								<div className="subject-list__row">
									<span
										className="subject-list__dot"
										style={{ background: subjectColors[name] ?? "var(--text-faint)" }}
									/>
									<input
										className="subject-list__name bs-input bs-input--sm"
										value={subj.displayName}
										aria-label={t("subject.name", { name })}
										onChange={(e) =>
											apply(updateSubject(pattern, name, { displayName: e.target.value }), {
												reseed: false,
											})
										}
									/>
									<span className="subject-list__meta">{counts[name]?.size ?? 0}</span>
									<button
										type="button"
										className="pattern-remove"
										data-bs-tooltip={t("subject.remove", { name })}
										title={onlyOneSubject ? t("subject.remove", { name }) : undefined}
										aria-label={t("subject.remove", { name })}
										disabled={onlyOneSubject}
										onClick={() => apply(removeSubject(pattern, name))}
									>
										<span className="pattern-icon">
											<GIcon glyph={GraphIcon.Close} />
										</span>
									</button>
								</div>
								<TypePicker
									className="subject-list__types"
									selected={subj.types}
									options={typeOptions}
									onChange={(next) => apply(updateSubject(pattern, name, { types: next }))}
								/>
								<WhereEditor
									subjectName={name}
									where={subj.where}
									onChange={(next) => apply(updateSubject(pattern, name, { where: next }))}
								/>
							</li>
						))}
						<li>
							<button
								type="button"
								className="pattern-add"
								disabled={!canAddSubject(pattern)}
								onClick={() => apply(addSubject(pattern))}
							>
								<span className="pattern-icon pattern-add__icon">
									<GIcon glyph={GraphIcon.Plus} />
								</span>
								<span>{t("subject.add")}</span>
							</button>
						</li>
					</ul>
				</section>

				<section className="sidebar-section">
					<h2>{t("section.connections")}</h2>
					<ul className="edge-list" id="edge-list">
						{pattern.edges.map((edge, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: edges are positional in the pattern.
							<li key={index} className="edge-list__item edge-list__item--editable">
								<SubjectSelect
									pattern={pattern}
									selected={edge.from}
									ariaLabel={t("edge.fromAria", { n: index + 1 })}
									onChange={(k) => apply(updateEdge(pattern, index, { from: k }))}
								/>
								<EnumSelect
									values={[EdgeDirection.Out, EdgeDirection.In, EdgeDirection.Both]}
									selected={edge.direction}
									ariaLabel={t("edge.dirAria", { n: index + 1 })}
									labelFor={edgeDirLabel}
									onChange={(v) => apply(updateEdge(pattern, index, { direction: v }))}
								/>
								<TypePicker
									selected={edge.linkTypes}
									options={linkOptions}
									onChange={(next) => apply(updateEdge(pattern, index, { linkTypes: next }))}
								/>
								<SubjectSelect
									pattern={pattern}
									selected={edge.to}
									ariaLabel={t("edge.toAria", { n: index + 1 })}
									onChange={(k) => apply(updateEdge(pattern, index, { to: k }))}
								/>
								<EnumSelect
									values={[EdgeMatch.Required, EdgeMatch.Optional, EdgeMatch.Forbidden]}
									selected={edge.match}
									ariaLabel={t("edge.matchAria", { n: index + 1 })}
									labelFor={edgeMatchLabel}
									onChange={(v) => apply(updateEdge(pattern, index, { match: v }))}
								/>
								<HopsSelect
									current={edge.hops}
									index={index}
									onChange={(next) => apply(updateEdge(pattern, index, { hops: next }))}
								/>
								<button
									type="button"
									className="pattern-remove"
									data-bs-tooltip={t("edge.removeAria", { n: index + 1 })}
									aria-label={t("edge.removeAria", { n: index + 1 })}
									onClick={() => apply(removeEdge(pattern, index))}
								>
									<span className="pattern-icon">
										<GIcon glyph={GraphIcon.Close} />
									</span>
								</button>
							</li>
						))}
						{pattern.edges.length === 0 ? (
							<li className="edge-list__item edge-list__item--empty">{t("edge.none")}</li>
						) : null}
						<li>
							<button
								type="button"
								className="pattern-add"
								disabled={!canAddEdge(pattern)}
								onClick={() => apply(addEdge(pattern))}
							>
								<span className="pattern-icon pattern-add__icon">
									<GIcon glyph={GraphIcon.Plus} />
								</span>
								<span>{t("edge.add")}</span>
							</button>
						</li>
					</ul>
				</section>
			</details>
		</div>
	);
}

function SubjectSelect({
	pattern,
	selected,
	ariaLabel,
	onChange,
}: {
	pattern: GraphPattern;
	selected: string;
	ariaLabel: string;
	onChange: (key: string) => void;
}): ReactElement {
	return (
		<SelectMenu
			className="bs-select--sm edge-select"
			ariaLabel={ariaLabel}
			value={selected}
			options={Object.entries(pattern.subjects).map(([k, subj]) => ({
				value: k,
				label: subj.displayName || k,
			}))}
			onChange={onChange}
		/>
	);
}

function EnumSelect<T extends string>({
	values,
	selected,
	ariaLabel,
	labelFor,
	onChange,
}: {
	values: readonly T[];
	selected: T;
	ariaLabel: string;
	labelFor: (value: T) => string;
	onChange: (value: T) => void;
}): ReactElement {
	return (
		<SelectMenu<T>
			className="bs-select--sm edge-select"
			ariaLabel={ariaLabel}
			value={selected}
			options={values.map((v) => ({ value: v, label: labelFor(v) }))}
			onChange={onChange}
		/>
	);
}

function HopsSelect({
	current,
	index,
	onChange,
}: {
	current: Hops;
	index: number;
	onChange: (next: Hops) => void;
}): ReactElement {
	return (
		<SelectMenu
			className="bs-select--sm edge-select"
			ariaLabel={t("edge.hops.aria", { n: index + 1 })}
			value={hopsKey(current)}
			options={hopsOptionsFor(current).map((window) => ({
				value: hopsKey(window),
				label: hopsLabel(window),
			}))}
			onChange={(key) => {
				const next = parseHopsKey(key);
				if (next) onChange(next);
			}}
		/>
	);
}

/* ── Export menu ────────────────────────────────────────────────────────── */

const DEST_COPY = "copy";
const DEST_SAVE = "save";

function openGraphExportPopover(controller: GraphCanvasController): void {
	const copy = (text: string): void => {
		void navigator.clipboard
			.writeText(text)
			.then(() => controller.requestRepaint())
			.catch(() => {});
	};
	const canSave = Boolean(getRuntime()?.services?.files);
	const destination: ExportSelectOption = {
		kind: ExportOptionKind.Select,
		id: "destination",
		label: t("export.destination"),
		default: DEST_COPY,
		choices: canSave
			? [
					{ value: DEST_COPY, label: t("export.toCopy") },
					{ value: DEST_SAVE, label: t("export.toFile") },
				]
			: [{ value: DEST_COPY, label: t("export.toCopy") }],
	};
	const textFormats: { id: GraphExportFormat; label: string }[] = [
		{ id: GraphExportFormat.Json, label: t("export.fmtJson") },
		{ id: GraphExportFormat.Dot, label: t("export.fmtDot") },
		{ id: GraphExportFormat.GraphML, label: t("export.fmtGraphml") },
		{ id: GraphExportFormat.Mermaid, label: t("export.fmtMermaid") },
	];
	const formats: ExportFormatSpec[] = textFormats.map((f) => ({
		id: f.id,
		label: f.label,
		options: [destination],
	}));
	formats.push({ id: "svg", label: t("export.fmtSvg"), options: [destination] });
	if (canSave) formats.push({ id: "png", label: t("export.fmtPng") });

	const text = (formatId: string): string =>
		formatId === "svg"
			? toSVG(controller.svgExportInput())
			: exportGraph(controller.effectiveDb(), formatId as GraphExportFormat);

	openExportPopover({
		spec: { formats },
		labels: {
			title: t("export.menu"),
			formatLegend: t("export.formatLegend"),
			exportAction: t("export.action"),
			cancel: t("export.cancel"),
		},
		onExport: ({ formatId, values }) => {
			if (formatId === "png") {
				void saveExportAsFile(controller, "png", () => svgToPng(toSVG(controller.svgExportInput())));
				return;
			}
			if (values.destination === DEST_SAVE) {
				const kind = (formatId === "svg" ? "svg" : formatId) as keyof typeof EXPORT_EXTENSIONS;
				void saveExportAsFile(controller, kind, () => textToBytes(text(formatId)));
			} else {
				copy(text(formatId));
			}
		},
	});
}

function ExportMenuButton({ controller }: { controller: GraphCanvasController }): ReactElement {
	const openExport = useCallback(() => openGraphExportPopover(controller), [controller]);

	return (
		<button
			type="button"
			className="header-icon-btn"
			aria-haspopup="dialog"
			aria-label={t("export.menu")}
			data-bs-tooltip={t("export.menu")}
			onClick={openExport}
		>
			<GIcon glyph={GraphIcon.Export} />
		</button>
	);
}

async function saveExportAsFile(
	controller: GraphCanvasController,
	kind: keyof typeof EXPORT_EXTENSIONS,
	encode: () => Uint8Array | Promise<Uint8Array>,
): Promise<void> {
	const files = getRuntime()?.services?.files;
	if (!files) return;
	const extension = EXPORT_EXTENSIONS[kind];
	const suggestedName = suggestedFilename(
		controller.getState().graphRecord?.name ?? null,
		extension,
		{
			defaultStem: "graph",
		},
	);
	const result = await requestSaveBytes(files, {
		title: t("export.saveDialogTitle"),
		suggestedName,
		filters: [{ name: kind.toUpperCase(), extensions: [extension] }],
		encode,
	});
	if (result.kind === SaveDispositionKind.Failed) {
		console.warn(`[graph/export] save failed for ${kind}:`, failureDetail(result.error));
	}
}

/* ── Settings panel ─────────────────────────────────────────────────────── */

type ForceKey =
	| "charge"
	| "chargeDistanceMax"
	| "linkDistance"
	| "centerStrength"
	| "collidePadding"
	| "collideStrength"
	| "velocityDecay"
	| "maxSpeed";

type ForceSliderSpec = {
	key: ForceKey;
	labelKey: Parameters<typeof t>[0];
	min: number;
	max: number;
	step: number;
	fromSlider: (raw: number) => number;
	toSlider: (value: number) => number;
	display: (value: number) => string;
};

const identity = (n: number): number => n;

const FORCE_SLIDERS: ReadonlyArray<ForceSliderSpec> = [
	{
		key: "charge",
		labelKey: "force.charge",
		min: -3000,
		max: -20,
		step: 10,
		fromSlider: identity,
		toSlider: identity,
		display: (v) => `−${Math.abs(v)}`,
	},
	{
		key: "chargeDistanceMax",
		labelKey: "force.chargeRange",
		min: 200,
		max: 4000,
		step: 50,
		fromSlider: identity,
		toSlider: identity,
		display: (v) => String(v),
	},
	{
		key: "linkDistance",
		labelKey: "force.linkDistance",
		min: 20,
		max: 600,
		step: 5,
		fromSlider: identity,
		toSlider: identity,
		display: (v) => String(v),
	},
	{
		key: "centerStrength",
		labelKey: "force.centerStrength",
		min: 0,
		max: 50,
		step: 1,
		fromSlider: (raw) => raw / 1000,
		toSlider: (v) => Math.round(v * 1000),
		display: (v) => v.toFixed(3),
	},
	{
		key: "collidePadding",
		labelKey: "force.collidePadding",
		min: 0,
		max: 40,
		step: 1,
		fromSlider: identity,
		toSlider: identity,
		display: (v) => String(v),
	},
	{
		key: "collideStrength",
		labelKey: "force.collideStrength",
		min: 0,
		max: 100,
		step: 5,
		fromSlider: (raw) => raw / 100,
		toSlider: (v) => Math.round(v * 100),
		display: (v) => v.toFixed(2),
	},
	{
		key: "velocityDecay",
		labelKey: "force.velocityDecay",
		min: 10,
		max: 90,
		step: 1,
		fromSlider: (raw) => raw / 100,
		toSlider: (v) => Math.round(v * 100),
		display: (v) => v.toFixed(2),
	},
	{
		key: "maxSpeed",
		labelKey: "force.maxSpeed",
		min: 5,
		max: 120,
		step: 1,
		fromSlider: identity,
		toSlider: identity,
		display: (v) => String(v),
	},
];

function SettingsPanel({
	controller,
	snap,
}: {
	controller: GraphCanvasController | null;
	snap: CanvasSnapshot | null;
}): ReactElement | null {
	if (!controller || !snap) return null;
	const settings = controller.getState().settings;
	const forces = controller.getState().forces;

	return (
		<div className="graph-sidebar__view graph-sidebar__view--settings" data-mode="settings">
			<section className="sidebar-section">
				<h2>{t("section.appearance")}</h2>
				<div className="settings-list">
					<div className="settings-toggle">
						<span>{t("setting.titles")}</span>
						<Checkbox
							ariaLabel={t("setting.titles")}
							checked={settings.showLabels}
							onChange={(checked) => {
								controller.setSettings({ showLabels: checked });
								controller.applySettingsToSvg();
								controller.requestRepaint();
								controller.schedulePersist();
							}}
						/>
					</div>
					<div className="settings-toggle">
						<span>{t("setting.arrows")}</span>
						<Checkbox
							ariaLabel={t("setting.arrows")}
							checked={settings.showArrows}
							onChange={(checked) => {
								controller.setSettings({ showArrows: checked });
								controller.applySettingsToSvg();
								controller.requestRepaint();
								controller.schedulePersist();
							}}
						/>
					</div>
					<div className="settings-toggle">
						<span>{t("setting.icons")}</span>
						<Checkbox
							ariaLabel={t("setting.icons")}
							checked={settings.showIcons}
							onChange={(checked) => {
								controller.setSettings({ showIcons: checked });
								controller.reconcileScene();
								controller.schedulePersist();
							}}
						/>
					</div>
				</div>
			</section>

			<section className="sidebar-section">
				<h2>{t("section.showOnGraph")}</h2>
				<div className="settings-list">
					<div className="settings-toggle">
						<span>{t("setting.unmatched")}</span>
						<Checkbox
							ariaLabel={t("setting.unmatched")}
							checked={settings.showUnmatched}
							onChange={(checked) => {
								controller.setSettings({ showUnmatched: checked });
								controller.reconcileScene();
								controller.schedulePersist();
							}}
						/>
					</div>
				</div>
			</section>

			<section className="sidebar-section">
				<h2>{t("section.localView")}</h2>
				<div className="settings-list">
					<div className="settings-toggle">
						<span>{t("setting.localMode")}</span>
						<Checkbox
							ariaLabel={t("setting.localMode")}
							checked={snap.localRootId !== null}
							onChange={(checked) =>
								checked ? controller.enterLocalView() : controller.setLocalRoot(null)
							}
						/>
					</div>
					<p className="sidebar-section__hint">{t("setting.localModeHint")}</p>
					<label className="settings-slider">
						<span className="settings-slider__row">
							<span>{t("setting.depth")}</span>
							<output id="local-depth-value">{snap.localDepth}</output>
						</span>
						<input
							type="range"
							min={MIN_LOCAL_DEPTH}
							max={MAX_LOCAL_DEPTH}
							step={1}
							value={snap.localDepth}
							onChange={(e) => controller.setLocalDepth(clampLocalDepth(Number(e.target.value)))}
						/>
					</label>
				</div>
			</section>

			<section className="sidebar-section">
				<h2>{t("section.forces")}</h2>
				<div className="settings-list">
					{FORCE_SLIDERS.map((spec) => (
						<label key={spec.key} className="settings-slider">
							<span className="settings-slider__row">
								<span>{t(spec.labelKey)}</span>
								<output>{spec.display(forces[spec.key])}</output>
							</span>
							<input
								type="range"
								min={spec.min}
								max={spec.max}
								step={spec.step}
								value={spec.toSlider(forces[spec.key])}
								onChange={(e) =>
									controller.setForces({ [spec.key]: spec.fromSlider(Number(e.target.value)) })
								}
							/>
						</label>
					))}
				</div>
			</section>

			<section className="sidebar-section">
				<h2>{t("section.layout")}</h2>
				<div className="settings-list">
					<button type="button" className="settings-button" onClick={() => controller.resetLayout()}>
						{t("setting.resetLayout")}
					</button>
					<p className="sidebar-section__hint">{t("setting.resetLayoutHint")}</p>
				</div>
			</section>
		</div>
	);
}

/* ── Legend ─────────────────────────────────────────────────────────────── */

const LEGEND_CATEGORIES: ReadonlyArray<LinkCategory> = [
	LinkCategory.PropertyReference,
	LinkCategory.BodyLink,
	LinkCategory.SharedAttribute,
];

function Legend({
	controller,
	snap,
}: {
	controller: GraphCanvasController | null;
	snap: CanvasSnapshot | null;
}): ReactElement | null {
	// `snap` is the re-render trigger (each canvas emit); the legend reads the
	// live scene off the controller.
	if (!controller || !snap) return null;
	const state = controller.getState();
	const counts = legendCounts(state.scene.renderEdges.map((e) => e.link));
	return (
		<div className="edge-legend" id="edge-legend" aria-label={t("legend.aria")}>
			{LEGEND_CATEGORIES.map((category) => {
				const count = counts[category];
				return (
					<div
						key={category}
						className={`edge-legend__row${count === 0 ? " edge-legend__row--empty" : ""}`}
					>
						<span
							className="edge-legend__swatch"
							style={{ background: edgeColorForCategory(category, state.theme) }}
						/>
						<span className="edge-legend__label">{linkCategoryLabel(category)}</span>
						<span className="edge-legend__count">{t("legend.count", { count })}</span>
					</div>
				);
			})}
		</div>
	);
}

/* ── Local badge ────────────────────────────────────────────────────────── */

function directionLabel(dir: LocalDirection): string {
	switch (dir) {
		case LocalDirection.In:
			return t("local.dirIn");
		case LocalDirection.Out:
			return t("local.dirOut");
		default:
			return t("local.dirBoth");
	}
}
function directionAria(dir: LocalDirection): string {
	switch (dir) {
		case LocalDirection.In:
			return t("local.dirInAria");
		case LocalDirection.Out:
			return t("local.dirOutAria");
		default:
			return t("local.dirBothAria");
	}
}

function LocalBadge({
	controller,
	snap,
}: {
	controller: GraphCanvasController | null;
	snap: CanvasSnapshot | null;
}): ReactElement | null {
	if (!controller || !snap || snap.localRootId === null) return null;
	const node = controller.getState().scene.renderNodes.find((n) => n.id === snap.localRootId);
	// The root can vanish from the scene mid-view (deleted / filtered out);
	// never surface its raw id fragment in that window (F-320).
	const label = node ? rawNodeLabel(node.entity) : t("local.rootGone");
	const depthText = plural(snap.localDepth, "local.hops", "local.hopsPlural");

	return (
		<div className="local-badge" id="local-badge" role="status">
			<span className="local-badge__text">{t("local.label", { label })}</span>
			<div className="local-badge__stepper" role="group" aria-label={t("local.depthAria")}>
				<button
					type="button"
					className="local-badge__step"
					data-bs-tooltip={t("local.fewerHops")}
					title={snap.localDepth <= MIN_LOCAL_DEPTH ? t("local.fewerHops") : undefined}
					aria-label={t("local.decreaseDepth")}
					disabled={snap.localDepth <= MIN_LOCAL_DEPTH}
					onClick={() => controller.setLocalParams({ depth: snap.localDepth - 1 })}
				>
					<GIcon glyph={GraphIcon.Minus} />
				</button>
				<span className="local-badge__step-value" aria-live="polite">
					{depthText}
				</span>
				<button
					type="button"
					className="local-badge__step"
					data-bs-tooltip={t("local.moreHops")}
					title={snap.localDepth >= MAX_LOCAL_DEPTH ? t("local.moreHops") : undefined}
					aria-label={t("local.increaseDepth")}
					disabled={snap.localDepth >= MAX_LOCAL_DEPTH}
					onClick={() => controller.setLocalParams({ depth: snap.localDepth + 1 })}
				>
					<GIcon glyph={GraphIcon.Plus} />
				</button>
			</div>
			<div className="local-badge__segmented" role="group" aria-label={t("local.directionAria")}>
				{[LocalDirection.In, LocalDirection.Both, LocalDirection.Out].map((dir) => {
					const active = snap.localDirection === dir;
					return (
						<button
							key={dir}
							type="button"
							className={`local-badge__seg${active ? " local-badge__seg--active" : ""}`}
							data-bs-tooltip={directionAria(dir)}
							aria-label={directionAria(dir)}
							aria-pressed={active}
							onClick={() => controller.setLocalParams({ direction: dir })}
						>
							{directionLabel(dir)}
						</button>
					);
				})}
			</div>
			<button
				type="button"
				className="local-badge__close"
				data-bs-tooltip={t("local.exit")}
				aria-label={t("local.exit")}
				onClick={() => controller.setLocalRoot(null)}
			>
				<GIcon glyph={GraphIcon.Close} />
			</button>
		</div>
	);
}

/* ── Canvas-owned popover hosts (filled imperatively by the controller) ──── */

/** 9.13.11 — the editable inspector for the canvas click-selection. Resolves the
 *  single selected node's entity from the live scene and writes edits through the
 *  controller's optimistic `updateNodeProperty`. */
function GraphSelectionInspector({
	controller,
	snap,
}: {
	controller: GraphCanvasController;
	snap: CanvasSnapshot;
}): ReactElement | null {
	const ids = snap.selectedIds;
	const entity =
		ids.length === 1
			? (controller.getState().scene.renderNodes.find((n) => n.id === ids[0])?.entity ?? null)
			: null;
	const services = (window as unknown as { brainstorm?: { services?: EntityCommentsServices } })
		.brainstorm?.services;
	return (
		<SelectionInspector
			selectedCount={ids.length}
			entity={entity}
			onCommit={(id, key, value) => void controller.updateNodeProperty(id, key, value)}
			services={services}
		/>
	);
}

function HoverPreviewHost(): ReactElement {
	return (
		<div className="hover-preview" id="hover-preview" role="tooltip" aria-hidden="true">
			<div className="hover-preview__row">
				<span className="hover-preview__glyph" id="hover-preview-glyph" />
				<div className="hover-preview__text">
					<div className="hover-preview__title" id="hover-preview-title" />
					<div className="hover-preview__type" id="hover-preview-type" />
				</div>
			</div>
			<div className="hover-preview__meta" id="hover-preview-meta" />
			<dl className="hover-preview__props" id="hover-preview-props" hidden />
		</div>
	);
}

function EdgeTooltipHost(): ReactElement {
	return (
		<div className="edge-tooltip" id="edge-tooltip" role="tooltip" aria-hidden="true">
			<span className="edge-tooltip__reason" id="edge-tooltip-reason" />
			<span className="edge-tooltip__ends" id="edge-tooltip-ends" />
		</div>
	);
}

/* ── History FAB + scrubber popover ─────────────────────────────────────── */

function formatCutoff(cutoffAt: number | null): string {
	if (cutoffAt === null) return t("history.now");
	// `2-digit` day (paired with the tabular-nums on the labels) keeps the
	// formatted width constant as the cutoff sweeps during playback — a
	// `numeric` day shifts 1→2 chars at the 9→10 boundary and the label jumps.
	return new Date(cutoffAt).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "2-digit",
	});
}

function HistoryFab({
	controller,
	snap,
}: {
	controller: GraphCanvasController | null;
	snap: CanvasSnapshot | null;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const fabRef = useRef<HTMLButtonElement>(null);
	const popRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && (popRef.current?.contains(target) || fabRef.current?.contains(target))) return;
			setOpen(false);
			if (snap?.isPlaying) controller?.togglePlayback();
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, [open, snap?.isPlaying, controller]);

	const cutoffLabel = formatCutoff(snap?.cutoffAt ?? null);
	const fraction =
		snap?.bounds && snap.cutoffAt !== null && snap.cutoffAt !== undefined
			? (snap.cutoffAt - snap.bounds.min) / Math.max(1, snap.bounds.max - snap.bounds.min)
			: 1;
	const barValue = Math.round(Math.max(0, Math.min(1, fraction)) * SCRUBBER_STEPS);

	return (
		<>
			<button
				ref={fabRef}
				type="button"
				className="history-fab"
				aria-label={t("history.fab")}
				aria-expanded={open}
				aria-controls="history-popover"
				onClick={(e) => {
					e.stopPropagation();
					setOpen((v) => !v);
				}}
			>
				<span className="history-fab__icon" aria-hidden="true">
					<GIcon glyph={GraphIcon.History} />
				</span>
				<span className="history-fab__label" id="history-fab-label">
					{cutoffLabel}
				</span>
			</button>
			{/* Anchored, non-modal scrubber panel: it must stay live while you drag
			    the time slider and watch the graph animate behind it, so it is NOT
			    `@brainstorm/sdk/popover` (a fixed, centred, full-viewport modal) —
			    no shared anchored-panel primitive exists yet. */}
			<div
				ref={popRef}
				className="history-popover"
				id="history-popover"
				role="dialog"
				aria-modal="false"
				data-permanent
				aria-label={t("history.dialog")}
				hidden={!open}
			>
				<div className="history-popover__row">
					<button
						type="button"
						className="history-scrubber__button"
						aria-label={t("history.playPause")}
						onClick={() => controller?.togglePlayback()}
					>
						<GIcon glyph={snap?.isPlaying ? GraphIcon.Pause : GraphIcon.Play} />
					</button>
					<button
						type="button"
						className="history-scrubber__button history-scrubber__button--text"
						aria-label={t("history.cycleSpeed")}
						onClick={() => {
							const current = (snap?.playbackSpeed ?? 1) as (typeof PLAYBACK_SPEEDS)[number];
							const idx = PLAYBACK_SPEEDS.indexOf(current);
							const next = PLAYBACK_SPEEDS[(idx + 1) % PLAYBACK_SPEEDS.length] ?? 1;
							controller?.setPlaybackSpeed(next);
						}}
					>
						{`${snap?.playbackSpeed ?? 1}×`}
					</button>
					<button
						type="button"
						className="history-scrubber__button history-scrubber__button--text"
						aria-label={t("history.cycleReveal")}
						onClick={() => {
							const idx = REVEAL_CYCLE.indexOf(snap?.reveal ?? HistoryReveal.Eased);
							const next = REVEAL_CYCLE[(idx + 1) % REVEAL_CYCLE.length] ?? HistoryReveal.Eased;
							controller?.setReveal(next);
						}}
					>
						{revealLabel(snap?.reveal ?? HistoryReveal.Eased)}
					</button>
					<output className="history-popover__date" id="scrubber-date">
						{cutoffLabel}
					</output>
				</div>
				<ScrubberHistogram controller={controller} snap={snap} />
				<input
					className="history-scrubber__bar"
					id="scrubber-bar"
					type="range"
					min={0}
					max={SCRUBBER_STEPS}
					step={1}
					value={barValue}
					aria-label={t("history.cutoff")}
					onChange={(e) => controller?.setCutoffFraction(Number(e.target.value) / SCRUBBER_STEPS)}
				/>
				<output className="history-popover__count" id="scrubber-count">
					{`${snap?.visibleNodeCount ?? 0} / ${snap?.totalNodeCount ?? 0}`}
				</output>
			</div>
		</>
	);
}

function ScrubberHistogram({
	controller,
	snap,
}: {
	controller: GraphCanvasController | null;
	snap: CanvasSnapshot | null;
}): ReactElement {
	const bars: ReactNode[] = [];
	const bounds = snap?.bounds ?? null;
	if (controller && bounds) {
		const db = controller.effectiveDb();
		const timestamps: number[] = [];
		for (const e of db.entities) timestamps.push(e.createdAt);
		for (const l of db.links) {
			if (l.deletedAt === null) timestamps.push(l.createdAt);
		}
		if (timestamps.length > 0) {
			const counts = bucketTimestamps(timestamps, bounds.min, bounds.max, HIST_BUCKETS);
			const revealedThrough = cutoffBucketIndex(
				snap?.cutoffAt ?? null,
				bounds.min,
				bounds.max,
				HIST_BUCKETS,
			);
			const peak = Math.max(1, ...counts);
			counts.forEach((count, i) => {
				bars.push(
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: histogram buckets are positional.
						key={i}
						className={
							i <= revealedThrough
								? "history-scrubber__hist-bar history-scrubber__hist-bar--revealed"
								: "history-scrubber__hist-bar"
						}
						style={{ height: `${Math.round((count / peak) * 100)}%` }}
					/>,
				);
			});
		}
	}
	return (
		<div className="history-scrubber__hist" id="scrubber-hist" aria-hidden="true">
			{bars}
		</div>
	);
}

/** Chrome sub-components exposed for unit tests — the canvas controller mounts
 *  Pixi (WebGL) which won't stand up under jsdom, so chrome tests drive these
 *  with a lightweight fake controller instead of the full `<GraphApp>`. */
export const __testing = {
	GraphHeader,
	FiltersPanel,
	SettingsPanel,
	Legend,
	LocalBadge,
	HistoryFab,
};
