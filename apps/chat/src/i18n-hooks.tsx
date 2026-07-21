import { type TFunction, type TParams, plural as sdkPlural } from "@brainstorm-os/sdk/i18n";
import { type LocaleRuntime, useLocalePackT } from "@brainstorm-os/sdk/i18n-react";
import { CHAT_I18N, type ChatMessageId, LOCALE_PACK_IMPORTERS } from "./i18n";

export function useChatT(runtime?: LocaleRuntime | null): TFunction<typeof CHAT_I18N> {
	return useLocalePackT(CHAT_I18N, LOCALE_PACK_IMPORTERS, runtime);
}

export function useChatPlural(runtime?: LocaleRuntime | null) {
	const translate = useChatT(runtime);
	return (count: number, oneKey: ChatMessageId, otherKey: ChatMessageId, params?: TParams): string =>
		sdkPlural(translate, count, oneKey, otherKey, params);
}
