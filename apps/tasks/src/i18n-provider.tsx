import { type ReactElement, type ReactNode, useEffect } from "react";
import { useTasksT } from "./i18n-hooks";
import { syncActiveTranslator } from "./i18n/t";

export function TasksI18nProvider({ children }: { children: ReactNode }): ReactElement {
	const t = useTasksT();
	useEffect(() => {
		syncActiveTranslator(t);
	}, [t]);
	return <>{children}</>;
}
