import { type TFunction, type TParams, plural as sdkPlural } from "@brainstorm-os/sdk/i18n";
import { type LocaleRuntime, useLocalePackT } from "@brainstorm-os/sdk/i18n-react";
import { LOCALE_PACK_IMPORTERS, TASKS_I18N, type TranslationKey } from "./i18n/t";

export function useTasksT(runtime?: LocaleRuntime | null): TFunction<typeof TASKS_I18N> {
	return useLocalePackT(TASKS_I18N, LOCALE_PACK_IMPORTERS, runtime);
}

export function useTasksPlural(runtime?: LocaleRuntime | null) {
	const translate = useTasksT(runtime);
	return (
		count: number,
		oneKey: TranslationKey,
		otherKey: TranslationKey,
		params?: TParams,
	): string => sdkPlural(translate, count, oneKey, otherKey, params);
}
