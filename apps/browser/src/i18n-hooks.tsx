import { type TFunction, type TParams, plural as sdkPlural } from "@brainstorm/sdk/i18n";
import { type LocaleRuntime, useLocalePackT } from "@brainstorm/sdk/i18n-react";
import { BROWSER_I18N, type BrowserI18nKey, LOCALE_PACK_IMPORTERS } from "./i18n";

export function useBrowserT(runtime?: LocaleRuntime | null): TFunction<typeof BROWSER_I18N> {
	return useLocalePackT(BROWSER_I18N, LOCALE_PACK_IMPORTERS, runtime);
}

export function useBrowserPlural(runtime?: LocaleRuntime | null) {
	const translate = useBrowserT(runtime);
	return (
		count: number,
		oneKey: BrowserI18nKey,
		otherKey: BrowserI18nKey,
		params?: TParams,
	): string => sdkPlural(translate, count, oneKey, otherKey, params);
}
