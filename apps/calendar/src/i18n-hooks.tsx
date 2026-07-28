import { type TFunction, type TParams, plural as sdkPlural } from "@brainstorm-os/sdk/i18n";
import { type LocaleRuntime, useLocalePackT } from "@brainstorm-os/sdk/i18n-react";
import { LOCALE_PACK_IMPORTERS, MANIFEST, type TKey } from "./i18n/t";

export function useCalendarT(runtime?: LocaleRuntime | null): TFunction<typeof MANIFEST> {
	return useLocalePackT(MANIFEST, LOCALE_PACK_IMPORTERS, runtime);
}

export function useCalendarPlural(runtime?: LocaleRuntime | null) {
	const translate = useCalendarT(runtime);
	return (count: number, oneKey: TKey, otherKey: TKey, params?: TParams): string =>
		sdkPlural(translate, count, oneKey, otherKey, params);
}
