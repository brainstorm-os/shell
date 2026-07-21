/**
 * Renderer-side Y.Doc replica resolver. The singleton accessor lives in
 * `@brainstorm-os/react-yjs` (`createYDocResolverAccessor`, shared with Notes /
 * Code Editor / Tasks); this wires it to the Journal's runtime getter.
 *
 * Standalone fallback: the preview drop (`vite preview`) exposes no
 * `services.entities` doc surface; `getYDocResolverApi()` returns null and
 * the day-body editor mount degrades to the read-only paragraph.
 */

import { createYDocResolverAccessor } from "@brainstorm-os/react-yjs";
import { getJournalRuntime } from "../runtime";

export const getYDocResolverApi = createYDocResolverAccessor(getJournalRuntime);
