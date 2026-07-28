import { type ReactElement, type ReactNode, useEffect } from "react";
import { useCalendarT } from "./i18n-hooks";
import { syncActiveTranslator } from "./i18n/t";

export function CalendarI18nProvider({ children }: { children: ReactNode }): ReactElement {
	const t = useCalendarT();
	useEffect(() => {
		syncActiveTranslator(t);
	}, [t]);
	return <>{children}</>;
}
