import { type ReactElement, type ReactNode, useEffect } from "react";
import { syncActiveTranslator } from "./i18n";
import { useAutomationsT } from "./i18n-hooks";

export function AutomationsI18nProvider({ children }: { children: ReactNode }): ReactElement {
	const t = useAutomationsT();
	useEffect(() => {
		syncActiveTranslator(t);
	}, [t]);
	return <>{children}</>;
}
