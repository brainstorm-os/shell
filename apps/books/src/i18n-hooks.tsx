import { type TFunction, type TParams, plural as sdkPlural } from "@brainstorm-os/sdk/i18n";
import { type LocaleRuntime, useLocalePackT } from "@brainstorm-os/sdk/i18n-react";
import { BOOKS_I18N, type BooksI18nKey, LOCALE_PACK_IMPORTERS } from "./i18n";

export function useBooksT(runtime?: LocaleRuntime | null): TFunction<typeof BOOKS_I18N> {
	return useLocalePackT(BOOKS_I18N, LOCALE_PACK_IMPORTERS, runtime);
}

export function useBooksPlural(runtime?: LocaleRuntime | null) {
	const translate = useBooksT(runtime);
	return (count: number, oneKey: BooksI18nKey, otherKey: BooksI18nKey, params?: TParams): string =>
		sdkPlural(translate, count, oneKey, otherKey, params);
}
