/**
 * 12.15 — mounts the locale-reactive translator and syncs it to the module-level
 * `t()` used by imperative palette / menu helpers.
 */

import { type ReactElement, type ReactNode, useEffect } from "react";
import { syncActiveTranslator } from "./i18n";
import { useCodeEditorT } from "./i18n-hooks";

export function CodeEditorI18nProvider({ children }: { children: ReactNode }): ReactElement {
	const t = useCodeEditorT();
	useEffect(() => {
		syncActiveTranslator(t);
	}, [t]);
	return <>{children}</>;
}
