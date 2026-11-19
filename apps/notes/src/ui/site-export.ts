/**
 * `buildSiteExportItems` — the "Publish website…" row on a note's object menu
 * (IE-12). The note and the sub-pages it embeds become a self-contained
 * static site, zipped and saved through the same single-file dialog as the
 * other exports; the site is built only after the user commits a location.
 *
 * A pure builder over injected surfaces (page lookup, doc transport, asset
 * fetch, Files host) so it unit-tests against stubs without a shell.
 */

import {
	MAX_SITE_ASSET_BYTES,
	type SiteArchive,
	type SiteArchiveInput,
	type SitePlan,
	type SitePlanInput,
	buildSiteArchive,
	planSite,
} from "@brainstorm-os/editor";
import {
	type SaveDisposition,
	SaveDispositionKind,
	type SaveFileService,
	requestSaveBytes,
	suggestedFilename,
} from "@brainstorm-os/sdk/export-file";
import { ExportOptionKind, openExportPopover } from "@brainstorm-os/sdk/export-popover";
import { IconName } from "@brainstorm-os/sdk/icon";
import type { ObjectMenuExtraItem } from "@brainstorm-os/sdk/object-menu";
import type { SiteAsset } from "@brainstorm-os/sdk/site-export";

const SITE_ARCHIVE_EXTENSION = "zip";
const PUBLISHED_TOKEN_NAME = /^--(color|space|radius)-/;
const BYTES_PER_MEGABYTE = 1024 * 1024;
const SUB_PAGES_OPTION_ID = "sub-pages";
const CONFIRM_POPOVER_TEST_ID = "notes-publish-site";

/** Values are the shell notification kinds, so a report posts as-is. */
export const SiteExportTone = {
	Success: "success",
	Warning: "warning",
	Error: "error",
} as const;
export type SiteExportTone = (typeof SiteExportTone)[keyof typeof SiteExportTone];

/** What the user is told once the save dialog is behind them. */
export type SiteExportReport = {
	tone: SiteExportTone;
	title: string;
	/** What was left out, when anything was. */
	detail?: string;
};

export type SiteExportStats = Pick<
	SiteArchive,
	"pageCount" | "truncated" | "skippedAssets" | "withheldAssets"
>;

export type SiteExportReportLabels = {
	saved: (pageCount: number, file: string) => string;
	pagesTruncated: (pageCount: number) => string;
	imagesSkipped: (count: number, limitMegabytes: number) => string;
	imagesWithheld: (count: number) => string;
	failed: string;
};

export type SiteExportLabels = {
	/** The object-menu row. */
	action: string;
	/** Save-dialog window title. */
	dialogTitle: string;
	/** Save-dialog filter name for the `.zip`. */
	filterName: string;
	/** Heading over the home page's list of pages. */
	pages: string;
	/** Title of a page that has none. */
	untitled: string;
	/** Stands in for a reference to a page outside the site. */
	unpublished: string;
	/** Title of the confirmation popover; names the page being published. */
	confirmTitle: string;
	/** Legend over the list of sub-pages to include. */
	subPagesLegend: string;
	/** Legend over the (single) output format. */
	formatLegend: string;
	/** The confirmation's primary button. */
	confirmAction: string;
	cancel: string;
};

export type SiteExportInput = {
	rootId: string;
	title: string;
	files: SaveFileService;
	getPage: SitePlanInput["getPage"];
	pageAccess: SitePlanInput["pageAccess"];
	transport: SitePlanInput["transport"];
	fetchAsset: SiteArchiveInput["fetchAsset"];
	/** The current theme's flattened design tokens, read at publish time. */
	readTokens: () => Record<string, string>;
	labels: SiteExportLabels;
	onResult?: (disposition: SaveDisposition, stats: SiteExportStats | null) => void;
};

/** The outcome in words, or `null` when there is nothing to say (cancelled).
 *  A failure is described by a fixed sentence — the error itself can carry a
 *  path or an id and is never shown. */
export function siteExportReport(
	disposition: SaveDisposition,
	stats: SiteExportStats | null,
	labels: SiteExportReportLabels,
): SiteExportReport | null {
	if (disposition.kind === SaveDispositionKind.Cancelled) return null;
	if (disposition.kind === SaveDispositionKind.Failed || !stats) {
		return { tone: SiteExportTone.Error, title: labels.failed };
	}
	const omissions = [
		...(stats.truncated ? [labels.pagesTruncated(stats.pageCount)] : []),
		...(stats.skippedAssets > 0
			? [labels.imagesSkipped(stats.skippedAssets, MAX_SITE_ASSET_BYTES / BYTES_PER_MEGABYTE)]
			: []),
		...(stats.withheldAssets > 0 ? [labels.imagesWithheld(stats.withheldAssets)] : []),
	];
	const title = labels.saved(stats.pageCount, disposition.handle.displayName);
	if (omissions.length === 0) return { tone: SiteExportTone.Success, title };
	return { tone: SiteExportTone.Warning, title, detail: omissions.join(" ") };
}

/** The theme the app is painted with right now: the shell sets every design
 *  token as an inline custom property on the root element. */
export function readThemeTokens(style: CSSStyleDeclaration): Record<string, string> {
	const tokens: Record<string, string> = {};
	for (let index = 0; index < style.length; index += 1) {
		const name = style.item(index);
		if (!PUBLISHED_TOKEN_NAME.test(name)) continue;
		const value = style.getPropertyValue(name).trim();
		if (value.length > 0) tokens[name] = value;
	}
	return tokens;
}

/** One vault asset's bytes and the MIME the asset protocol serves it as. */
export async function fetchVaultAsset(assetId: string): Promise<SiteAsset | null> {
	const response = await fetch(`brainstorm://asset/${encodeURIComponent(assetId)}`);
	if (!response.ok) return null;
	const mime = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
	const bytes = new Uint8Array(await response.arrayBuffer());
	return bytes.length > 0 && mime.length > 0 ? { bytes, mime } : null;
}

async function saveSite(
	input: SiteExportInput,
	plan: SitePlan,
	confirmedIds: readonly string[],
): Promise<void> {
	let stats: SiteExportStats | null = null;
	const disposition = await requestSaveBytes(input.files, {
		title: input.labels.dialogTitle,
		suggestedName: suggestedFilename(input.title, SITE_ARCHIVE_EXTENSION),
		filters: [{ name: input.labels.filterName, extensions: [SITE_ARCHIVE_EXTENSION] }],
		encode: async () => {
			const archive = await buildSiteArchive({
				plan,
				confirmedIds,
				fetchAsset: input.fetchAsset,
				tokens: input.readTokens(),
				labels: {
					pages: input.labels.pages,
					untitled: input.labels.untitled,
					unpublished: input.labels.unpublished,
				},
			});
			stats = archive;
			return archive.bytes;
		},
	});
	input.onResult?.(disposition, stats);
}

/** Work out which pages belong to the site, show that exact list, and only
 *  on confirmation ask where to save. Nothing is published that the user did
 *  not see ticked. */
export async function openSiteExport(input: SiteExportInput): Promise<void> {
	let plan: SitePlan;
	try {
		plan = await planSite({
			rootId: input.rootId,
			getPage: input.getPage,
			pageAccess: input.pageAccess,
			transport: input.transport,
		});
	} catch (error) {
		input.onResult?.({ kind: SaveDispositionKind.Failed, error }, null);
		return;
	}
	const subPages = plan.pages.filter((page) => page.id !== plan.rootId);
	openExportPopover({
		testId: CONFIRM_POPOVER_TEST_ID,
		spec: {
			formats: [
				{
					id: SITE_ARCHIVE_EXTENSION,
					label: input.labels.filterName,
					...(subPages.length > 0
						? {
								options: [
									{
										kind: ExportOptionKind.Checklist,
										id: SUB_PAGES_OPTION_ID,
										label: input.labels.subPagesLegend,
										choices: subPages.map((page) => ({
											value: page.id,
											label: page.title.trim() || input.labels.untitled,
										})),
										default: subPages.map((page) => page.id),
									},
								],
							}
						: {}),
				},
			],
		},
		labels: {
			title: input.labels.confirmTitle,
			formatLegend: input.labels.formatLegend,
			exportAction: input.labels.confirmAction,
			cancel: input.labels.cancel,
		},
		onExport: ({ values }) => {
			const ticked = values[SUB_PAGES_OPTION_ID];
			return saveSite(input, plan, Array.isArray(ticked) ? ticked : []);
		},
	});
}

export function buildSiteExportItems(input: SiteExportInput): ObjectMenuExtraItem[] {
	return [
		{
			id: "publish-website",
			label: input.labels.action,
			icon: IconName.OpenExternal,
			run: () => void openSiteExport(input),
		},
	];
}
