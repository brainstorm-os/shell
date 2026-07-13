import { type ReactElement, type ReactNode, useEffect } from "react";
import { syncActiveTranslator } from "./i18n";
import { useThemeEditorT } from "./i18n-hooks";

export function ThemeEditorI18nProvider({ children }: { children: ReactNode }): ReactElement {
	const t = useThemeEditorT();
	useEffect(() => {
		syncActiveTranslator(t);
	}, [t]);
	return <>{children}</>;
}
