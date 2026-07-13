import { type ReactElement, type ReactNode, useEffect } from "react";
import { syncActiveTranslator } from "./i18n";
import { useContactsT } from "./i18n-hooks";

export function ContactsI18nProvider({ children }: { children: ReactNode }): ReactElement {
	const t = useContactsT();
	useEffect(() => {
		syncActiveTranslator(t);
	}, [t]);
	return <>{children}</>;
}
