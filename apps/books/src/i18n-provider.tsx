import { type ReactElement, type ReactNode, useEffect } from "react";
import { syncActiveTranslator } from "./i18n";
import { useBooksT } from "./i18n-hooks";

export function BooksI18nProvider({ children }: { children: ReactNode }): ReactElement {
	const t = useBooksT();
	useEffect(() => {
		syncActiveTranslator(t);
	}, [t]);
	return <>{children}</>;
}
