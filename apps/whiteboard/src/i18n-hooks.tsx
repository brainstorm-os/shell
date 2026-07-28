import type { TFunction, TParams } from "@brainstorm-os/sdk/i18n";
import { type LocaleRuntime, useLocalePackT } from "@brainstorm-os/sdk/i18n-react";
import {
	LOCALE_PACK_IMPORTERS,
	WHITEBOARD_MANIFEST,
	type WhiteboardMessageKey,
	pluralWith,
} from "./i18n/t";

export function useWhiteboardT(
	runtime?: LocaleRuntime | null,
): TFunction<typeof WHITEBOARD_MANIFEST> {
	return useLocalePackT(WHITEBOARD_MANIFEST, LOCALE_PACK_IMPORTERS, runtime);
}

export function useWhiteboardPlural(runtime?: LocaleRuntime | null) {
	const translate = useWhiteboardT(runtime);
	return (
		count: number,
		oneKey: WhiteboardMessageKey,
		otherKey: WhiteboardMessageKey,
		params?: TParams,
	): string => pluralWith(translate, count, oneKey, otherKey, params);
}
