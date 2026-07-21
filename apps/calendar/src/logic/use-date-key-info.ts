/**
 * `useDateKeyInfo` — live view of which property keys are `Date`-typed (9.15f).
 *
 * Reads the vault property catalog via the `properties` service and keeps the
 * derived `DateKeyInfo` fresh as the catalog changes, so any entity carrying a
 * date property projects onto the calendar. Falls back to the well-known date
 * keys when the service is absent (preview / older shell) or the catalog is
 * sparse (a vault that never ran the dev seeder). This is catalog metadata, not
 * a live entity list — the `@brainstorm-os/react-yjs` entity hooks don't cover it.
 */

import { type PropertiesService, ValueType } from "@brainstorm-os/sdk-types";
import { useEffect, useState } from "react";
import { type DateKeyInfo, buildDateKeyInfo } from "./from-vault-entities";

export function useDateKeyInfo(properties: PropertiesService | null): DateKeyInfo {
	const [info, setInfo] = useState<DateKeyInfo>(() => buildDateKeyInfo([]));
	useEffect(() => {
		if (!properties) {
			setInfo(buildDateKeyInfo([]));
			return;
		}
		let cancelled = false;
		const refresh = () => {
			void properties
				.list()
				.then((snap) => {
					if (cancelled) return;
					const dateDefs = Object.values(snap.properties)
						.filter((def) => def.valueType === ValueType.Date)
						.map((def) => ({ key: def.key, name: def.name }));
					setInfo(buildDateKeyInfo(dateDefs));
				})
				.catch((error: unknown) => console.warn("[calendar] properties.list failed", error));
		};
		refresh();
		const sub = properties.onChange(refresh);
		return () => {
			cancelled = true;
			sub.unsubscribe();
		};
	}, [properties]);
	return info;
}
