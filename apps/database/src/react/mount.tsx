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
	count,
	clearLabel,
	onClear,
}: { count: number; clearLabel: string; onClear: () => void }): ReactElement {
	return (
		<div className="db-selection-bar">
			{/* Database scaffold has no app-side `t()` yet; moves behind `createT` with `clearLabel` when Database adopts SDK i18n. i18n-exempt */}
			<span className="db-selection-bar__count">{count} selected</span>
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
	selection: { count: number; clearLabel: string; onClear: () => void } | null;
	children?: ReactNode;
}): ReactElement {
	return (
		<>
			{selection && selection.count > 1 ? (
				<SelectionBar
					count={selection.count}
					clearLabel={selection.clearLabel}
					onClear={selection.onClear}
				/>
			) : null}
			{children}
		</>
	);
}

/* ── Public, JSX-free helpers for `app.ts` (which stays `.ts`) ─────── */

export type SelectionProps = { count: number; clearLabel: string; onClear: () => void };

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
