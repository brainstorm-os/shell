/**
 * vCard import / export actions (9.23.4) — the glue between the pure vCard
 * codec and the Files-host service. Both orchestrators take the files service +
 * callbacks as parameters (no runtime singleton reach), so they unit-test
 * against a stub. Mirrors `apps/calendar` ics-actions.
 */

import {
	SaveDispositionKind,
	requestSaveBytes,
	suggestedFilename,
	textToBytes,
} from "@brainstorm-os/sdk/export-file";
import { t } from "../i18n";
import { type VCardContact, parseVCards, serializeVCards } from "../logic/vcard";
import type { ContactsFilesService } from "../runtime";

const VCF_EXTENSION = "vcf";

function vcardFilters(): { name: string; extensions: string[] }[] {
	return [{ name: t("vcard.filterName"), extensions: [VCF_EXTENSION] }];
}

/** Serialize `contacts` to a `.vcf` file via the save dialog. No-op (with a
 *  notice) when there's nothing to export. */
export async function exportContactsToVCard(
	files: ContactsFilesService,
	contacts: readonly VCardContact[],
	notify?: (message: string) => void,
): Promise<void> {
	if (contacts.length === 0) {
		notify?.(t("vcard.exportEmpty"));
		return;
	}
	const result = await requestSaveBytes(files, {
		title: t("vcard.saveDialogTitle"),
		suggestedName: suggestedFilename(t("app.title"), VCF_EXTENSION, { defaultStem: "contacts" }),
		filters: vcardFilters(),
		encode: () => textToBytes(serializeVCards(contacts)),
	});
	switch (result.kind) {
		case SaveDispositionKind.Saved:
			notify?.(t("vcard.exported", { count: contacts.length }));
			return;
		case SaveDispositionKind.Cancelled:
			return;
		case SaveDispositionKind.Failed:
			notify?.(t("vcard.exportFailed"));
			console.warn("[contacts/vcard] export failed", result.error);
			return;
	}
}

/** Open one or more `.vcf` files, parse every card, and hand the merged list to
 *  `onImport` (which creates the `Person/v1` rows). */
export async function importContactsFromVCard(
	files: ContactsFilesService,
	onImport: (contacts: VCardContact[]) => Promise<void> | void,
	notify?: (message: string) => void,
): Promise<void> {
	try {
		const handles = await files.requestOpen({
			title: t("vcard.openDialogTitle"),
			filters: vcardFilters(),
			multiple: true,
		});
		if (!handles || handles.length === 0) return; // cancelled
		const decoder = new TextDecoder();
		const all: VCardContact[] = [];
		for (const handle of handles) {
			const bytes = await files.read(handle);
			all.push(...parseVCards(decoder.decode(bytes)));
		}
		if (all.length === 0) {
			notify?.(t("vcard.importNone"));
			return;
		}
		await onImport(all);
		notify?.(t("vcard.imported", { count: all.length }));
	} catch (error) {
		notify?.(t("vcard.importFailed"));
		console.warn("[contacts/vcard] import failed", error);
	}
}
