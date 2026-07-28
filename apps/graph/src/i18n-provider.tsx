import { type ReactElement, type ReactNode, useEffect } from "react";
import { useGraphT } from "./i18n-hooks";
import { syncActiveTranslator } from "./i18n/t";

export function GraphI18nProvider({ children }: { children: ReactNode }): ReactElement {
	const t = useGraphT();
	useEffect(() => {
		syncActiveTranslator(t);
	}, [t]);
	return <>{children}</>;
}
