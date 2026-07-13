import { type ReactElement, type ReactNode, useEffect } from "react";
import { syncActiveTranslator } from "./i18n";
import { useMailboxT } from "./i18n-hooks";

export function MailboxI18nProvider({ children }: { children: ReactNode }): ReactElement {
	const t = useMailboxT();
	useEffect(() => {
		syncActiveTranslator(t);
	}, [t]);
	return <>{children}</>;
}
