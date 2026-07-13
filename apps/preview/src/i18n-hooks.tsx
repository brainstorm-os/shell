import { type TFunction, type TParams, plural as sdkPlural } from "@brainstorm/sdk/i18n";
import { type LocaleRuntime, useLocalePackT } from "@brainstorm/sdk/i18n-react";
import { LOCALE_PACK_IMPORTERS, PREVIEW_I18N, type PreviewI18nKey } from "./i18n";

export function usePreviewT(runtime?: LocaleRuntime | null): TFunction<typeof PREVIEW_I18N> {
	return useLocalePackT(PREVIEW_I18N, LOCALE_PACK_IMPORTERS, runtime);
}

export function usePreviewPlural(runtime?: LocaleRuntime | null) {
	const translate = usePreviewT(runtime);
	return (
		count: number,
		oneKey: PreviewI18nKey,
		otherKey: PreviewI18nKey,
		params?: TParams,
	): string => sdkPlural(translate, count, oneKey, otherKey, params);
}
