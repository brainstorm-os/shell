import { type ReactElement, type ReactNode, useEffect } from "react";
import { syncActiveTranslator } from "./i18n";
import { useBrowserT } from "./i18n-hooks";

export function BrowserI18nProvider({ children }: { children: ReactNode }): ReactElement {
	const t = useBrowserT();
	useEffect(() => {
		syncActiveTranslator(t);
	}, [t]);
	return <>{children}</>;
}
