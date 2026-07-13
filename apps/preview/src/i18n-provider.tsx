import { type ReactElement, type ReactNode, useEffect } from "react";
import { syncActiveTranslator } from "./i18n";
import { usePreviewT } from "./i18n-hooks";

export function PreviewI18nProvider({ children }: { children: ReactNode }): ReactElement {
	const t = usePreviewT();
	useEffect(() => {
		syncActiveTranslator(t);
	}, [t]);
	return <>{children}</>;
}
