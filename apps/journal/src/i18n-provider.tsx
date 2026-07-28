import { type ReactElement, type ReactNode, useEffect } from "react";
import { useJournalT } from "./i18n-hooks";
import { syncActiveTranslator } from "./logic/journal-i18n";

export function JournalI18nProvider({ children }: { children: ReactNode }): ReactElement {
	const t = useJournalT();
	useEffect(() => {
		syncActiveTranslator(t);
	}, [t]);
	return <>{children}</>;
}
