/**
 * `@brainstorm-os/sdk/layout-chrome` — the shell-rendered chrome cells
 * a `Layout/v1` can place (Stage 8.4, resolving **OQ-90 as (a):
 * shell-curated, closed set**).
 *
 * Pass `chromeSeam(host)` as `<LayoutView seams.renderChrome>`. Import
 * the CSS subpath (`@brainstorm-os/sdk/layout-chrome.css`).
 */

export { chromeSeam, renderChromeCell } from "./ChromeCells";
export {
	type ActionBarOptions,
	type BreadcrumbOptions,
	BREADCRUMB_ELLIPSIS_ID,
	type ChromeAction,
	ChromeActionId,
	ChromeAlignment,
	type ChromeCrumb,
	type ChromeHost,
	type ChromeMetaField,
	type ChromeTab,
	type ChromeWindowControls,
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
