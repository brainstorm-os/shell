/**
 * React-root manager for the Database app stage.
 *
 * 9.12.R1 — `app.ts` stays the imperative orchestrator (state /
 * persistence / vault wiring); its `renderActiveView` ferries the
 * per-render snapshot into one persistent `react-dom/client` root
 * rendered into `#stage-body`. Every view kind is a first-class React
 * component now (some still delegate their body painting to imperative
 * helpers in `render/` via `<DomPaint>`, but they live in the React
 * tree — no separate ImperativeBridge middleware).
 */

import { type ReactElement, type ReactNode, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";

/** Single persistent root per host. Re-mount only when the host element
 *  itself changes — re-rendering the same host reuses the same root, so
 *  React state and dnd sensors survive across `renderActiveView` calls. */
let active: { host: HTMLElement; root: Root } | null = null;

export function mountReactRoot(host: HTMLElement, element: ReactElement): void {
	if (!active || active.host !== host) {
		if (active) active.root.unmount();
		host.replaceChildren();
		active = { host, root: createRoot(host) };
	}
	active.root.render(element);
}

export function unmountReactRoot(): void {
	if (!active) return;
	active.root.unmount();
	active = null;
}

/** A second persistent root for the inspector property list (independent of
 *  the stage root). The host element is created once by `app.ts` and
 *  re-appended across inspector re-renders, so this root reconciles rather
 *  than remounting. */
let inspectorRoot: { host: HTMLElement; root: Root } | null = null;

export function mountInspectorProps(host: HTMLElement, element: ReactElement): void {
	if (!inspectorRoot || inspectorRoot.host !== host) {
		if (inspectorRoot) inspectorRoot.root.unmount();
		inspectorRoot = { host, root: createRoot(host) };
	}
	inspectorRoot.root.render(element);
}

/** Selection-count chip (header strip) — surfaces above the active view
 *  body when more than one entity is selected. Pulled out of `app.ts`'s
 *  imperative `renderSelectionBar` unchanged in markup / behavior. */
export function SelectionBar({
	countLabel,
	clearLabel,
	onClear,
	actions,
}: SelectionProps): ReactElement {
	return (
		<div className="db-selection-bar">
			<span className="db-selection-bar__count">{countLabel}</span>
			{(actions ?? []).map((action) => (
				<button
					key={action.id}
					type="button"
					className="bs-btn bs-btn--secondary bs-btn--sm db-selection-bar__action"
					data-testid={`db-selection-${action.id}`}
					{...(action.opensMenu ? { "aria-haspopup": "menu" as const } : {})}
					onClick={(event) => action.onClick(event.currentTarget)}
				>
					{action.label}
				</button>
			))}
			<button
				type="button"
				className="bs-btn bs-btn--secondary bs-btn--sm db-selection-bar__clear"
				onClick={onClear}
			>
				{clearLabel}
			</button>
		</div>
	);
}

/** Honest, deliberately-minimal stage empty per the "empty vault = empty app"
 *  pattern — intentionally NOT the SDK's `<EmptyState>` Hero (no glyph/CTA). Named
 *  `StageEmpty` so it doesn't shadow the SDK component name. */
export function StageEmpty({ title, body }: { title: string; body: string }): ReactElement {
	return (
		<div className="db-stage__empty" role="status" aria-live="polite">
			<p className="db-stage__empty-title">{title}</p>
			<p className="db-stage__empty-body">{body}</p>
		</div>
	);
}

/** Top-level shape of an active-view render — chrome + the view body. */
export function ActiveBody({
	selection,
	children,
}: {
	selection: SelectionProps | null;
	children?: ReactNode;
}): ReactElement {
	return (
		<>
			{selection && (selection.count > 1 || (selection.actions?.length ?? 0) > 0) ? (
				<SelectionBar {...selection} />
			) : null}
			{children}
		</>
	);
}

/* ── Public, JSX-free helpers for `app.ts` (which stays `.ts`) ─────── */

export type SelectionAction = {
	id: string;
	label: string;
	opensMenu?: boolean;
	onClick: (anchor: HTMLElement) => void;
};

export type SelectionProps = {
	count: number;
	countLabel: string;
	clearLabel: string;
	onClear: () => void;
	/** Bulk actions over the selection (9.12.32). */
	actions?: ReadonlyArray<SelectionAction>;
};

/** Mount an empty-state into the stage body. */
export function renderEmpty(host: HTMLElement, props: { title: string; body: string }): void {
	mountReactRoot(host, createElement(StageEmpty, props));
}

/** Mount the active-view chrome + a React view body. */
export function renderViewBodyReact(
	host: HTMLElement,
	props: { selection: SelectionProps | null; element: ReactElement },
): void {
	const body = createElement(ActiveBody, { selection: props.selection }, props.element);
	mountReactRoot(host, body);
}
