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
	buildSiteArchive,
} from "@brainstorm-os/editor";
import {
	type SaveDisposition,
	SaveDispositionKind,
	type SaveFileService,
	requestSaveBytes,
	suggestedFilename,
} from "@brainstorm-os/sdk/export-file";
import { IconName } from "@brainstorm-os/sdk/icon";
import type { ObjectMenuExtraItem } from "@brainstorm-os/sdk/object-menu";
import type { SiteAsset } from "@brainstorm-os/sdk/site-export";

const SITE_ARCHIVE_EXTENSION = "zip";
const PUBLISHED_TOKEN_NAME = /^--(color|space|radius)-/;
const BYTES_PER_MEGABYTE = 1024 * 1024;

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

export type SiteExportStats = Pick<SiteArchive, "pageCount" | "truncated" | "skippedAssets">;

export type SiteExportReportLabels = {
	saved: (pageCount: number, file: string) => string;
	pagesTruncated: (pageCount: number) => string;
	imagesSkipped: (count: number, limitMegabytes: number) => string;
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
};

export type SiteExportInput = {
	rootId: string;
	title: string;
	files: SaveFileService;
	getPage: SiteArchiveInput["getPage"];
	transport: SiteArchiveInput["transport"];
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

export async function runSiteExport(input: SiteExportInput): Promise<void> {
	let stats: SiteExportStats | null = null;
	const disposition = await requestSaveBytes(input.files, {
		title: input.labels.dialogTitle,
		suggestedName: suggestedFilename(input.title, SITE_ARCHIVE_EXTENSION),
		filters: [{ name: input.labels.filterName, extensions: [SITE_ARCHIVE_EXTENSION] }],
		encode: async () => {
			const archive = await buildSiteArchive({
				rootId: input.rootId,
				getPage: input.getPage,
				transport: input.transport,
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

export function buildSiteExportItems(input: SiteExportInput): ObjectMenuExtraItem[] {
	return [
		{
			id: "publish-website",
			label: input.labels.action,
			icon: IconName.OpenExternal,
			run: () => void runSiteExport(input),
		},
	];
}
