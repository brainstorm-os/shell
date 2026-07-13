import { type ReactElement, type ReactNode, useEffect } from "react";
import { syncActiveTranslator } from "./i18n";
import { useFormDesignerT } from "./i18n-hooks";

export function FormDesignerI18nProvider({ children }: { children: ReactNode }): ReactElement {
	const t = useFormDesignerT();
	useEffect(() => {
		syncActiveTranslator(t);
	}, [t]);
	return <>{children}</>;
}
