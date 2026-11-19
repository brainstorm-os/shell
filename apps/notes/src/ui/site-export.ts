/**
 * `buildSiteExportItems` — the "Publish website…" row on a note's object menu
 * (IE-12). The note and the sub-pages it embeds become a self-contained
 * static site, zipped and saved through the same single-file dialog as the
 * other exports; the site is built only after the user commits a location.
 *
 * A pure builder over injected surfaces (page lookup, doc transport, asset
 * fetch, Files host) so it unit-tests against stubs without a shell.
 */

import { type SiteArchiveInput, buildSiteArchive } from "@brainstorm-os/editor";
import {
	type SaveDisposition,
	type SaveFileService,
	requestSaveBytes,
	suggestedFilename,
} from "@brainstorm-os/sdk/export-file";
import { IconName } from "@brainstorm-os/sdk/icon";
import type { ObjectMenuExtraItem } from "@brainstorm-os/sdk/object-menu";
import type { SiteAsset } from "@brainstorm-os/sdk/site-export";

const SITE_ARCHIVE_EXTENSION = "zip";
const PUBLISHED_TOKEN_NAME = /^--(color|space|radius)-/;

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
	onResult?: (disposition: SaveDisposition) => void;
};

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
			return archive.bytes;
		},
	});
	input.onResult?.(disposition);
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
