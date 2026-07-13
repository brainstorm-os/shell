/**
 * Launcher palette — `⌘ K` (or `Ctrl+K`) command palette over the
 * dashboard. Migrated to `@react-fancy-menus` at Stage 8.8. Surfaces two
 * sections:
 *
 *   - **Apps** — installed apps that match the query (ranked: prefix → name
 *     substring → description substring). Enter launches.
 *   - **Entities** — FTS5 hits from the vault-wide search index, grouped
 *     under the section header. Enter dispatches `intent.open` with the
 *     entity id; the IntentsBus routes to the owning app's primary `open`
 *     handler.
 *
 * Stage 9.22.2 wires the entity half. The shell renderer is shell-trusted
 * so search + intent dispatch ride privileged `ipcMain.handle` channels
 * (`window.brainstorm.search.query`, `window.brainstorm.intents.dispatch`)
 * — NOT the broker.
 *
 * Result rendering, navigation, and section assembly stay in pure
 * `grouped-results.ts`; this file is the React + IPC glue that feeds the
 * built rows into the menu. The menu owns chrome, filtering input, keyboard
 * navigation (section headers are skipped automatically), focus, and the
 * escape-stack entry; `<Launcher>` opens/closes it in step with the `open`
 * prop and pushes fresh rows via `updateData` as apps load + search lands.
 */

import {
	BodyKind,
	DimmerMode,
	Horizontal,
	type MenuConfig,
	MenuState,
	PanelKind,
	RowKind,
	SourceKind,
	Vertical,
	defineMenu,
	useMenu,
	useMenuState,
} from "@brainstorm/sdk/menus";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { InstalledApp, IntentDispatchResult, SearchHit } from "../../preload";
import { t } from "../i18n/t";
import { formatOpenExplainer } from "../intents/open-explainer";
import { Icon, IconName } from "../ui/icon";
import { pushToast } from "../ui/toasts";
import { LauncherRowKind, buildRows } from "./grouped-results";
import type { LauncherAppRow, LauncherEntityRow, LauncherRow } from "./grouped-results";
import "./launcher.css";
import { prettyEntityType, sanitizeSnippet } from "./launcher-text";

export type LauncherProps = {
	open: boolean;
	onClose: () => void;
	/** 9.8.9 — pre-fill the palette with a query handed off by an app's
	 *  `ui.openSearch` (the Files vault-scope flip). Null/absent = clean. */
	initialQuery?: string | null;
};

export const LAUNCHER_MENU_ID = "shell/launcher-menu";

/** Debounce window for entity queries — lets the user type a few chars
 *  before the FTS5 pass fires. */
const SEARCH_DEBOUNCE_MS = 120;
/** Hard cap on entity hits we show. */
const SEARCH_LIMIT = 20;

type LauncherData = { rows: LauncherRow[] };

/** Stable handler box so the config (built once) reads the latest setters /
 *  close callback without rebuilding (and re-registering) on every render. */
type Handlers = { onQuery: (value: string) => void; onClose: () => void };

function appRowContent(app: InstalledApp): ReactNode {
	return (
		<span className="launcher-menu__row">
			<span className="launcher-menu__icon" aria-hidden="true">
				{app.hasIcon ? (
					<img
						src={`brainstorm://app-icon/${encodeURIComponent(app.id)}`}
						alt=""
						width={20}
						height={20}
					/>
				) : (
					<Icon name={IconName.App} />
				)}
			</span>
			<span className="launcher-menu__body">
				<span className="launcher-menu__title">{app.name}</span>
				<span className="launcher-menu__subtitle">
					{app.description ?? t("shell.launcher.app.subtitle", { version: app.version })}
				</span>
			</span>
		</span>
	);
}

function entityRowContent(row: LauncherEntityRow): ReactNode {
	const subtitle = t("shell.launcher.entity.subtitle", {
		appName: row.ownerAppName,
		type: prettyEntityType(row.hit.type),
	});
	return (
		<span className="launcher-menu__row">
			<span className="launcher-menu__icon" aria-hidden="true">
				<Icon name={IconName.Entity} />
			</span>
			<span className="launcher-menu__body">
				<span className="launcher-menu__title">{row.hit.title || row.hit.entityId}</span>
				{row.hit.snippet ? (
					<span
						className="launcher-menu__snippet"
						// FTS5 emits `<mark>…</mark>` from a fixed lhs/rhs we pass in;
						// `sanitizeSnippet` escapes every other angle bracket so a note
						// containing literal HTML can't break out.
						// biome-ignore lint/security/noDangerouslySetInnerHtml: snippet sanitiser strips all HTML except literal <mark> markers
						dangerouslySetInnerHTML={{ __html: sanitizeSnippet(row.hit.snippet) }}
					/>
				) : null}
				<span className="launcher-menu__subtitle">{subtitle}</span>
			</span>
		</span>
	);
}

function buildConfig(handlers: { current: Handlers }): MenuConfig<LauncherData> {
	return defineMenu<LauncherData>({
		id: LAUNCHER_MENU_ID,
		chrome: {
			role: "dialog",
			ariaLabel: t("shell.launcher.title"),
			dimmer: DimmerMode.Default,
			className: "launcher-menu",
		},
		// Spotlight placement: the open call anchors a collapsed rect at the
		// upper third of the viewport, so the TOP edge stays pinned while the
		// result list streams in below (rows load async — a viewport-centred
		// menu would be positioned at its empty height and then grow past the
		// bottom edge). `fillViewport` caps the list at the viewport bottom.
		position: {
			width: 640,
			fillViewport: true,
			vertical: Vertical.Bottom,
			horizontal: Horizontal.Center,
			noFlipY: true,
		},
		body: {
			kind: BodyKind.Composed,
			sections: [
				{
					id: "search",
					kind: PanelKind.SearchInput,
					placeholder: t("shell.launcher.placeholder"),
					focusOnMount: true,
					onChange: (value) => handlers.current.onQuery(value),
					onClear: () => handlers.current.onQuery(""),
				},
				{
					id: "list",
					kind: BodyKind.List,
					source: { kind: SourceKind.Prop, getItems: (data: LauncherData) => data.rows },
					rows: [
						{
							kind: RowKind.Section,
							match: (r: LauncherRow) => r.rowKind === LauncherRowKind.SectionHeader,
							name: (r: LauncherRow) => (r.rowKind === LauncherRowKind.SectionHeader ? r.label : ""),
						},
						{
							kind: RowKind.Item,
							match: (r: LauncherRow) => r.rowKind === LauncherRowKind.App,
							isBig: true,
							name: (r: LauncherRow) => (r.rowKind === LauncherRowKind.App ? appRowContent(r.app) : ""),
							onClick: (r, _e, ctx) => {
								if (r.rowKind !== LauncherRowKind.App) return;
								activateApp(r, handlers.current.onClose);
								ctx.close();
							},
						},
						{
							kind: RowKind.Item,
							match: (r: LauncherRow) => r.rowKind === LauncherRowKind.Entity,
							isBig: true,
							name: (r: LauncherRow) => (r.rowKind === LauncherRowKind.Entity ? entityRowContent(r) : ""),
							onClick: (r, _e, ctx) => {
								if (r.rowKind !== LauncherRowKind.Entity) return;
								activateEntity(r, handlers.current.onClose);
								ctx.close();
							},
						},
					],
					emptyState: { kind: PanelKind.EmptyState, message: t("shell.launcher.empty") },
				},
			],
		},
		keyboard: { defaults: { closeOnEscape: true, selectOnEnter: true } },
	});
}

/** Write `value` into the mounted launcher menu's search input. The input
 *  is owned by the fancy-menus runtime (a React-controlled element), so the
 *  native value setter + a bubbling `input` event are required for the
 *  runtime's onChange to observe the write. Best-effort: a missing input
 *  (menu not yet painted) leaves only the visible text un-prefilled — the
 *  result rows are driven by the component's own `query` state regardless. */
function prefillSearchInput(value: string): void {
	const input = document.querySelector<HTMLInputElement>(".launcher-menu input");
	if (!input) return;
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	if (!setter) return;
	setter.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function Launcher({ open, onClose, initialQuery }: LauncherProps) {
	const [query, setQuery] = useState("");
	const [apps, setApps] = useState<InstalledApp[]>([]);
	const [entities, setEntities] = useState<SearchHit[]>([]);

	const { open: openMenu, close, register, updateData } = useMenu();
	const state = useMenuState(LAUNCHER_MENU_ID);

	const handlersRef = useRef<Handlers>({ onQuery: setQuery, onClose });
	handlersRef.current.onQuery = setQuery;
	handlersRef.current.onClose = onClose;
	const config = useMemo(() => buildConfig(handlersRef), []);

	// Load the installed-app list each time the launcher opens, and reset the
	// transient query / entity state so a reopen starts clean (or pre-filled,
	// when a `ui.openSearch` handoff supplied a query). A ref carries the
	// handoff value so a re-render mid-session can't re-reset the query.
	const initialQueryRef = useRef<string | null>(initialQuery ?? null);
	initialQueryRef.current = initialQuery ?? null;
	useEffect(() => {
		if (!open) return;
		setQuery(initialQueryRef.current ?? "");
		setEntities([]);
		let cancelled = false;
		void window.brainstorm.apps.listInstalled().then((list) => {
			if (!cancelled) setApps(list);
		});
		return () => {
			cancelled = true;
		};
	}, [open]);

	// Debounced entity search — most recent query wins via `tokenRef` so a
	// slow FTS5 pass can't overwrite a fresher result.
	const tokenRef = useRef(0);
	useEffect(() => {
		if (!open) return;
		const norm = query.trim();
		if (norm.length === 0) {
			setEntities([]);
			return;
		}
		const myToken = ++tokenRef.current;
		const timer = setTimeout(() => {
			void window.brainstorm.search
				.query({ text: norm, limit: SEARCH_LIMIT })
				.then((hits) => {
					if (myToken === tokenRef.current) setEntities(hits);
				})
				.catch((error: unknown) => {
					if (myToken !== tokenRef.current) return;
					console.warn("[brainstorm] launcher search failed:", error);
					setEntities([]);
				});
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [query, open]);

	const labels = useMemo(
		() => ({
			sectionApps: t("shell.launcher.section.apps"),
			sectionEntities: t("shell.launcher.section.entities"),
		}),
		[],
	);

	const rows = useMemo<LauncherRow[]>(
		() => (open ? buildRows({ query, apps, entities, labels }) : []),
		[apps, entities, query, open, labels],
	);

	// Open / close the menu in step with the `open` prop. After the menu
	// mounts, mirror a handed-off query into the (runtime-owned) search
	// input — the fancy-menus SearchInput has no initial-value param, so the
	// visible text is synced via the DOM; the `query` state above already
	// drives the result rows either way.
	useEffect(() => {
		if (open) {
			register(config);
			// Collapsed anchor rect at top-centre — see the position comment
			// in `buildConfig` (the runtime ignores per-open `position`, so
			// the anchor rect is the only way to place an unanchored menu).
			void Promise.resolve(
				openMenu(LAUNCHER_MENU_ID, {
					data: { rows: [] },
					rect: new DOMRect(
						Math.round(window.innerWidth / 2),
						Math.round(window.innerHeight * 0.16),
						0,
						0,
					),
				}),
			).then(() => {
				const value = initialQueryRef.current;
				if (value) prefillSearchInput(value);
			});
		} else {
			close(LAUNCHER_MENU_ID);
		}
	}, [open, openMenu, close, register, config]);

	// Push freshly-built rows as apps load + search results land.
	useEffect(() => {
		if (open) updateData(LAUNCHER_MENU_ID, { rows });
	}, [rows, open, updateData]);

	// Bridge the menu's own dismissal (Escape / backdrop) back to the
	// dashboard's `launcherOpen` boolean.
	const wasOpenRef = useRef(false);
	useEffect(() => {
		if (state === MenuState.Open || state === MenuState.Opening) {
			wasOpenRef.current = true;
		} else if (wasOpenRef.current && state === MenuState.Closed) {
			// Always reset the ref on close — an item-click close runs with
			// `open` already false (the row handler called onClose first), and
			// a ref left `true` makes the NEXT open read as "dismissed" here
			// the moment it mounts, auto-closing the palette.
			wasOpenRef.current = false;
			if (open) onClose();
		}
	}, [state, open, onClose]);

	return null;
}

function activateApp(row: LauncherAppRow, onClose: () => void): void {
	void window.brainstorm.apps.launch(row.app.id);
	onClose();
}

function activateEntity(row: LauncherEntityRow, onClose: () => void): void {
	// Try `intent.open` first — when an app registers an `open` handler for
	// the entity's type, the IntentsBus routes there. Falls back to launching
	// the owning app fresh if no handler is registered.
	void window.brainstorm.intents
		.dispatch({
			verb: "open",
			payload: { entityId: row.hit.entityId, entityType: row.hit.type },
		})
		.then((result) => {
			pushExplainerToast(result);
			if (!result.handled && result.rung === undefined) {
				void window.brainstorm.apps.launch(row.hit.ownerAppId);
			}
		})
		.catch((error: unknown) => {
			console.warn("[brainstorm] launcher: intent.open dispatch failed:", error);
			void window.brainstorm.apps.launch(row.hit.ownerAppId);
		});
	onClose();
}

/** OpenRes-1c — surface the "why did this open here?" explainer when the
 *  dispatch result carries a stamped rung/refusal. */
function pushExplainerToast(result: IntentDispatchResult): void {
	const spec = formatOpenExplainer(result);
	if (!spec) return;
	pushToast({
		kind: spec.kind,
		title: t(spec.titleKey, spec.params),
		...(spec.bodyKey ? { body: t(spec.bodyKey, spec.params) } : {}),
	});
}
