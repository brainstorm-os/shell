import { type ReactElement, type ReactNode, useEffect } from "react";
import { useNotesT } from "./i18n-hooks";
import { syncActiveTranslator } from "./i18n/t";

export function NotesI18nProvider({ children }: { children: ReactNode }): ReactElement {
	const t = useNotesT();
	useEffect(() => {
		syncActiveTranslator(t);
	}, [t]);
	return <>{children}</>;
}
