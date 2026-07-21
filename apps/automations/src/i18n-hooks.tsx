import { type TFunction, type TParams, plural as sdkPlural } from "@brainstorm-os/sdk/i18n";
import { type LocaleRuntime, useLocalePackT } from "@brainstorm-os/sdk/i18n-react";
import { AUTOMATIONS_I18N, type AutomationsI18nKey, LOCALE_PACK_IMPORTERS } from "./i18n";

export function useAutomationsT(
	runtime?: LocaleRuntime | null,
): TFunction<typeof AUTOMATIONS_I18N> {
	return useLocalePackT(AUTOMATIONS_I18N, LOCALE_PACK_IMPORTERS, runtime);
}

export function useAutomationsPlural(runtime?: LocaleRuntime | null) {
	const translate = useAutomationsT(runtime);
	return (
		count: number,
		oneKey: AutomationsI18nKey,
		otherKey: AutomationsI18nKey,
		params?: TParams,
	): string => sdkPlural(translate, count, oneKey, otherKey, params);
}
