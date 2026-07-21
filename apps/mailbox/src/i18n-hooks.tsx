import { type TFunction, type TParams, plural as sdkPlural } from "@brainstorm-os/sdk/i18n";
import { type LocaleRuntime, useLocalePackT } from "@brainstorm-os/sdk/i18n-react";
import { LOCALE_PACK_IMPORTERS, MAILBOX_I18N, type MailboxI18nKey } from "./i18n";

export function useMailboxT(runtime?: LocaleRuntime | null): TFunction<typeof MAILBOX_I18N> {
	return useLocalePackT(MAILBOX_I18N, LOCALE_PACK_IMPORTERS, runtime);
}

export function useMailboxPlural(runtime?: LocaleRuntime | null) {
	const translate = useMailboxT(runtime);
	return (
		count: number,
		oneKey: MailboxI18nKey,
		otherKey: MailboxI18nKey,
		params?: TParams,
	): string => sdkPlural(translate, count, oneKey, otherKey, params);
}
