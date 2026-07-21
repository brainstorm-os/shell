/**
 * Renderer-side Y.Doc replica resolver. The singleton accessor lives in
 * `@brainstorm-os/react-yjs` (`createYDocResolverAccessor`, shared with Notes /
 * Journal / Code Editor); this wires it to the Tasks runtime getter.
 *
 * Standalone fallback: the preview drop (`vite preview`, Playwright harness
 * without the preload) exposes no `services.entities` doc surface;
 * `getYDocResolverApi()` returns null and the inspector degrades to a
 * read-only legacy-notes block.
 */

import { createYDocResolverAccessor } from "@brainstorm-os/react-yjs";
import { getBrainstorm } from "../storage/runtime";

export const getYDocResolverApi = createYDocResolverAccessor(getBrainstorm);
