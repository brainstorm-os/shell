/**
 * The six shell-rendered chrome cells (Stage 8.4).
 *
 * Doc 27's decision: "the shell renders no fixed chrome outside of the
 * layout system — every structural element a user sees around an entity
 * is a layout cell." These are those elements. They draw with theme
 * tokens and the shared control faces, and they take their *data* from
 * the host (see `contract.ts`) because chrome cannot know an app's
 * navigation.
 *
 * The set is closed (OQ-90 (a)) — `renderChromeCell` is exhaustive over
 * `ChromeKind`, so adding a kind is a compile error until it has a
 * renderer, and an app that wants its own structural element uses a
 * `block` cell instead.
 */

import { type ChromeCell, ChromeKind } from "@brainstorm-os/sdk-types";
import type { ReactElement } from "react";
import {
	type ActionBarOptions,
	BREADCRUMB_ELLIPSIS_ID,
	type BreadcrumbOptions,
	ChromeAlignment,
	type ChromeHost,
	type EntityHeaderOptions,
	type MetaOptions,
	type WindowControlsOptions,
	actionBarOptions,
	breadcrumbOptions,
	collapseCrumbs,
	entityHeaderOptions,
	metaOptions,
	selectActions,
	selectMetaFields,
	windowControlsOptions,
} from "./contract";

const alignClass = (alignment: ChromeAlignment): string => `bs-chrome--align-${alignment}`;

function ActionBar({
	host,
	options,
}: { host: ChromeHost; options: ActionBarOptions }): ReactElement {
	const actions = selectActions(host.actions ?? [], options.buttons);
	return (
		<div className={`bs-chrome bs-chrome__action-bar ${alignClass(options.alignment)}`}>
			{actions.map((action) => (
				<button
					key={action.id}
					type="button"
					className="bs-btn bs-btn--sm bs-btn--ghost"
					disabled={action.disabled}
					aria-label={action.label}
					data-bs-tooltip={action.label}
					data-action-id={action.id}
					onClick={(event) => action.onSelect(event.currentTarget)}
				>
					{action.icon ?? action.label}
				</button>
			))}
		</div>
	);
}

function Breadcrumb({
	host,
	options,
}: { host: ChromeHost; options: BreadcrumbOptions }): ReactElement {
	const crumbs = collapseCrumbs(host.breadcrumb ?? [], options.maxItems);
	return (
		<nav className="bs-chrome bs-chrome__breadcrumb" aria-label={host.t?.("breadcrumb")}>
			<ol className="bs-chrome__crumbs">
				{crumbs.map((crumb, index) => (
					<li key={crumb.id} className="bs-chrome__crumb">
						{crumb.onNavigate ? (
							<button
								type="button"
								className="bs-chrome__crumb-link"
								onClick={crumb.onNavigate}
								data-crumb-id={crumb.id}
							>
								{crumb.icon}
								{crumb.label}
							</button>
						) : (
							<span
								className="bs-chrome__crumb-current"
								data-crumb-id={crumb.id}
								aria-current={
									crumb.id !== BREADCRUMB_ELLIPSIS_ID && index === crumbs.length - 1 ? "page" : undefined
								}
							>
								{crumb.icon}
								{crumb.label}
							</span>
						)}
					</li>
				))}
			</ol>
		</nav>
	);
}

function Meta({ host, options }: { host: ChromeHost; options: MetaOptions }): ReactElement {
	const fields = selectMetaFields(host.meta ?? [], options.fields);
	return (
		<dl className="bs-chrome bs-chrome__meta">
			{fields.map((field) => (
				<div key={field.id} className="bs-chrome__meta-row" data-meta-id={field.id}>
					<dt className="bs-chrome__meta-label">{field.label}</dt>
					<dd className="bs-chrome__meta-value">{field.value}</dd>
				</div>
			))}
		</dl>
	);
}

function WindowControls({
	host,
	options,
}: { host: ChromeHost; options: WindowControlsOptions }): ReactElement | null {
	const controls = host.windowControls;
	if (!controls) return null;
	return (
		<div
			className={`bs-chrome bs-chrome__window-controls ${alignClass(options.alignment)}`}
			role="group"
		>
			<button
				type="button"
				className="bs-btn bs-btn--sm bs-btn--ghost bs-btn--icon"
				aria-label={controls.minimizeLabel}
				data-window-control="minimize"
				onClick={controls.onMinimize}
			/>
			<button
				type="button"
				className="bs-btn bs-btn--sm bs-btn--ghost bs-btn--icon"
				aria-label={controls.maximizeLabel}
				data-window-control="maximize"
				onClick={controls.onMaximize}
			/>
			<button
				type="button"
				className="bs-btn bs-btn--sm bs-btn--ghost bs-btn--icon"
				aria-label={controls.closeLabel}
				data-window-control="close"
				onClick={controls.onClose}
			/>
		</div>
	);
}

/** The composite "conventional shape" header — icon + title + action bar
 *  — for layout authors who want it without composing three cells. */
function EntityHeader({
	host,
	options,
}: { host: ChromeHost; options: EntityHeaderOptions }): ReactElement {
	return (
		<header className={`bs-chrome bs-chrome__entity-header ${alignClass(options.alignment)}`}>
			{options.showIcon && host.icon ? (
				<span className="bs-chrome__entity-icon">{host.icon}</span>
			) : null}
			<h2 className="bs-chrome__entity-title">{host.title ?? ""}</h2>
			{options.showActions ? (
				<ActionBar host={host} options={{ alignment: ChromeAlignment.End }} />
			) : null}
		</header>
	);
}

function Tabs({ host }: { host: ChromeHost }): ReactElement {
	const tabs = host.tabs ?? [];
	return (
		<div className="bs-chrome bs-chrome__tabs" role="tablist">
			{tabs.map((tab) => (
				<button
					key={tab.id}
					type="button"
					role="tab"
					className="bs-chrome__tab"
					aria-selected={Boolean(tab.active)}
					data-tab-id={tab.id}
					onClick={tab.onSelect}
				>
					{tab.icon}
					{tab.label}
				</button>
			))}
		</div>
	);
}

/**
 * Render one chrome cell. This is the function a host passes as
 * `<LayoutView seams.renderChrome>`; `chromeSeam(host)` below binds it.
 */
export function renderChromeCell(cell: ChromeCell, host: ChromeHost): ReactElement | null {
	switch (cell.chrome) {
		case ChromeKind.ActionBar:
			return <ActionBar host={host} options={actionBarOptions(cell.options)} />;
		case ChromeKind.Breadcrumb:
			return <Breadcrumb host={host} options={breadcrumbOptions(cell.options)} />;
		case ChromeKind.Meta:
			return <Meta host={host} options={metaOptions(cell.options)} />;
		case ChromeKind.WindowControls:
			return <WindowControls host={host} options={windowControlsOptions(cell.options)} />;
		case ChromeKind.EntityHeader:
			return <EntityHeader host={host} options={entityHeaderOptions(cell.options)} />;
		case ChromeKind.Tabs:
			return <Tabs host={host} />;
		default:
			// Exhaustive over the curated set (OQ-90 (a)) — an added kind is
			// a compile error here until it has a renderer.
			return null;
	}
}

/** Bind a host to the chrome renderer, ready for `LayoutViewSeams`. */
export function chromeSeam(host: ChromeHost): (cell: ChromeCell) => ReactElement | null {
	return (cell) => renderChromeCell(cell, host);
}
