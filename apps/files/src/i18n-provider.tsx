import { type ReactElement, type ReactNode, useEffect } from "react";
import { syncActiveTranslator } from "./i18n";
import { useFilesT } from "./i18n-hooks";

export function FilesI18nProvider({ children }: { children: ReactNode }): ReactElement {
	const t = useFilesT();
	useEffect(() => {
		syncActiveTranslator(t);
	}, [t]);
	return <>{children}</>;
}
