import { type ReactElement, type ReactNode, useEffect } from "react";
import { useWhiteboardT } from "./i18n-hooks";
import { syncActiveTranslator } from "./i18n/t";

export function WhiteboardI18nProvider({ children }: { children: ReactNode }): ReactElement {
	const t = useWhiteboardT();
	useEffect(() => {
		syncActiveTranslator(t);
	}, [t]);
	return <>{children}</>;
}
