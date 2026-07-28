import { type TFunction, type TParams, plural as sdkPlural } from "@brainstorm-os/sdk/i18n";
import { type LocaleRuntime, useLocalePackT } from "@brainstorm-os/sdk/i18n-react";
import {
	BOOKMARKS_MESSAGES,
	type BookmarksMessageKey,
	LOCALE_PACK_IMPORTERS,
} from "./i18n/manifest";

export function useBookmarksT(
	runtime?: LocaleRuntime | null,
): TFunction<typeof BOOKMARKS_MESSAGES> {
	return useLocalePackT(BOOKMARKS_MESSAGES, LOCALE_PACK_IMPORTERS, runtime);
}

export function useBookmarksPlural(runtime?: LocaleRuntime | null) {
	const translate = useBookmarksT(runtime);
	return (
		count: number,
		oneKey: BookmarksMessageKey,
		otherKey: BookmarksMessageKey,
		params?: TParams,
	): string => sdkPlural(translate, count, oneKey, otherKey, params);
}
