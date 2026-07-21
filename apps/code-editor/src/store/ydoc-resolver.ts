/**
 * Renderer-side Y.Doc replica resolver. The singleton accessor lives in
 * `@brainstorm-os/react-yjs` (`createYDocResolverAccessor`, shared with Notes /
 * Journal / Tasks); this wires it to the Code Editor's runtime getter.
 *
 * Standalone fallback: the preview drop (`vite preview`) exposes neither
 * `services.entities` nor `window.brainstorm.ydoc`; `getYDocResolverApi()`
 * returns null and the editor degrades to an in-memory `Y.Doc`.
 */

import { createYDocResolverAccessor } from "@brainstorm-os/react-yjs";
import { getCodeEditorRuntime } from "../runtime";

export const getYDocResolverApi = createYDocResolverAccessor(getCodeEditorRuntime);
