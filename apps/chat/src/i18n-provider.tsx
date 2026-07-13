import { type ReactElement, type ReactNode, useEffect } from "react";
import { syncActiveTranslator } from "./i18n";
import { useChatT } from "./i18n-hooks";

export function ChatI18nProvider({ children }: { children: ReactNode }): ReactElement {
	const t = useChatT();
	useEffect(() => {
		syncActiveTranslator(t);
	}, [t]);
	return <>{children}</>;
}
