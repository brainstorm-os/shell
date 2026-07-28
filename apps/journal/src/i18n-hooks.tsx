import { type TParams, plural as sdkPlural } from "@brainstorm-os/sdk/i18n";
import { type LocaleRuntime, useLocalePackT } from "@brainstorm-os/sdk/i18n-react";
import {
	JOURNAL_I18N,
	type JournalI18nKey,
	type JournalManifest,
	type JournalT,
	LOCALE_PACK_IMPORTERS,
} from "./logic/journal-i18n";

export function useJournalT(runtime?: LocaleRuntime | null): JournalT {
	return useLocalePackT(JOURNAL_I18N, LOCALE_PACK_IMPORTERS, runtime);
}

export function useJournalPlural(runtime?: LocaleRuntime | null) {
	const translate = useJournalT(runtime);
	return (
		count: number,
		oneKey: JournalI18nKey,
		otherKey: JournalI18nKey,
		params?: TParams,
	): string => sdkPlural<JournalManifest>(translate, count, oneKey, otherKey, params);
}
