import { type ReactElement, type ReactNode, useEffect } from "react";
import { syncActiveTranslator } from "./i18n";
import { useAgentT } from "./i18n-hooks";

export function AgentI18nProvider({ children }: { children: ReactNode }): ReactElement {
	const t = useAgentT();
	useEffect(() => {
		syncActiveTranslator(t);
	}, [t]);
	return <>{children}</>;
}
