import { type TFunction, type TParams, plural as sdkPlural } from "@brainstorm-os/sdk/i18n";
import { type LocaleRuntime, useLocalePackT } from "@brainstorm-os/sdk/i18n-react";
import { GRAPH_I18N, type GraphI18nKey, LOCALE_PACK_IMPORTERS } from "./i18n/manifest";

export function useGraphT(runtime?: LocaleRuntime | null): TFunction<typeof GRAPH_I18N> {
	return useLocalePackT(GRAPH_I18N, LOCALE_PACK_IMPORTERS, runtime);
}

export function useGraphPlural(runtime?: LocaleRuntime | null) {
	const translate = useGraphT(runtime);
	return (count: number, oneKey: GraphI18nKey, otherKey: GraphI18nKey, params?: TParams): string =>
		sdkPlural(translate, count, oneKey, otherKey, params);
}
