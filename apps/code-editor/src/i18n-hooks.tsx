import { type TFunction, type TParams, plural as sdkPlural } from "@brainstorm-os/sdk/i18n";
import { type LocaleRuntime, useLocalePackT } from "@brainstorm-os/sdk/i18n-react";
import { CODE_EDITOR_MESSAGES, type CodeEditorMessageKey, LOCALE_PACK_IMPORTERS } from "./i18n";

export function useCodeEditorT(
	runtime?: LocaleRuntime | null,
): TFunction<typeof CODE_EDITOR_MESSAGES> {
	return useLocalePackT(CODE_EDITOR_MESSAGES, LOCALE_PACK_IMPORTERS, runtime);
}

export function useCodeEditorPlural(runtime?: LocaleRuntime | null) {
	const translate = useCodeEditorT(runtime);
	return (
		count: number,
		oneKey: CodeEditorMessageKey,
		otherKey: CodeEditorMessageKey,
		params?: TParams,
	): string => sdkPlural(translate, count, oneKey, otherKey, params);
}
