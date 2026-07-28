import { type ReactElement, type ReactNode, useEffect } from "react";
import { useBookmarksT } from "./i18n-hooks";
import { syncActiveTranslator } from "./i18n/manifest";

export function BookmarksI18nProvider({ children }: { children: ReactNode }): ReactElement {
	const t = useBookmarksT();
	useEffect(() => {
		syncActiveTranslator(t);
	}, [t]);
	return <>{children}</>;
}
