import { type TFunction, type TParams, plural as sdkPlural } from "@brainstorm-os/sdk/i18n";
import { type LocaleRuntime, useLocalePackT } from "@brainstorm-os/sdk/i18n-react";
import { CONTACTS_I18N, type ContactsI18nKey, LOCALE_PACK_IMPORTERS } from "./i18n";

export function useContactsT(runtime?: LocaleRuntime | null): TFunction<typeof CONTACTS_I18N> {
	return useLocalePackT(CONTACTS_I18N, LOCALE_PACK_IMPORTERS, runtime);
}

export function useContactsPlural(runtime?: LocaleRuntime | null) {
	const translate = useContactsT(runtime);
	return (
		count: number,
		oneKey: ContactsI18nKey,
		otherKey: ContactsI18nKey,
		params?: TParams,
	): string => sdkPlural(translate, count, oneKey, otherKey, params);
}
