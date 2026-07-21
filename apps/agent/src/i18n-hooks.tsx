import { type TFunction, type TParams, plural as sdkPlural } from "@brainstorm-os/sdk/i18n";
import { type LocaleRuntime, useLocalePackT } from "@brainstorm-os/sdk/i18n-react";
import { AGENT_I18N, type AgentI18nKey, LOCALE_PACK_IMPORTERS } from "./i18n";

export function useAgentT(runtime?: LocaleRuntime | null): TFunction<typeof AGENT_I18N> {
	return useLocalePackT(AGENT_I18N, LOCALE_PACK_IMPORTERS, runtime);
}

export function useAgentPlural(runtime?: LocaleRuntime | null) {
	const translate = useAgentT(runtime);
	return (count: number, oneKey: AgentI18nKey, otherKey: AgentI18nKey, params?: TParams): string =>
		sdkPlural(translate, count, oneKey, otherKey, params);
}
