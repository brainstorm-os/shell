import { type TFunction, type TParams, plural as sdkPlural } from "@brainstorm/sdk/i18n";
import { type LocaleRuntime, useLocalePackT } from "@brainstorm/sdk/i18n-react";
import { THEME_EDITOR_I18N, type ThemeEditorI18nKey, LOCALE_PACK_IMPORTERS } from "./i18n";

export function useThemeEditorT(runtime?: LocaleRuntime | null): TFunction<typeof THEME_EDITOR_I18N> {
	return useLocalePackT(THEME_EDITOR_I18N, LOCALE_PACK_IMPORTERS, runtime);
}

export function useThemeEditorPlural(runtime?: LocaleRuntime | null) {
	const translate = useThemeEditorT(runtime);
	return (
		count: number,
		oneKey: ThemeEditorI18nKey,
		otherKey: ThemeEditorI18nKey,
		params?: TParams,
	): string => sdkPlural(translate, count, oneKey, otherKey, params);
}
