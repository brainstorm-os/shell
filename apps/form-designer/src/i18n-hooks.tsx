import { type TFunction, type TParams, plural as sdkPlural } from "@brainstorm-os/sdk/i18n";
import { type LocaleRuntime, useLocalePackT } from "@brainstorm-os/sdk/i18n-react";
import { FORM_DESIGNER_I18N, type FormDesignerI18nKey, LOCALE_PACK_IMPORTERS } from "./i18n";

export function useFormDesignerT(
	runtime?: LocaleRuntime | null,
): TFunction<typeof FORM_DESIGNER_I18N> {
	return useLocalePackT(FORM_DESIGNER_I18N, LOCALE_PACK_IMPORTERS, runtime);
}

export function useFormDesignerPlural(runtime?: LocaleRuntime | null) {
	const translate = useFormDesignerT(runtime);
	return (
		count: number,
		oneKey: FormDesignerI18nKey,
		otherKey: FormDesignerI18nKey,
		params?: TParams,
	): string => sdkPlural(translate, count, oneKey, otherKey, params);
}
