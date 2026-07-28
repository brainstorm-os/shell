import { type TFunction, type TParams, plural as sdkPlural } from "@brainstorm-os/sdk/i18n";
import { type LocaleRuntime, useLocalePackT } from "@brainstorm-os/sdk/i18n-react";
import { LOCALE_PACK_IMPORTERS, NOTES_I18N, type NotesI18nKey } from "./i18n/t";

export function useNotesT(runtime?: LocaleRuntime | null): TFunction<typeof NOTES_I18N> {
	return useLocalePackT(NOTES_I18N, LOCALE_PACK_IMPORTERS, runtime);
}

export function useNotesPlural(runtime?: LocaleRuntime | null) {
	const translate = useNotesT(runtime);
	return (count: number, oneKey: NotesI18nKey, otherKey: NotesI18nKey, params?: TParams): string =>
		sdkPlural(translate, count, oneKey, otherKey, params);
}
