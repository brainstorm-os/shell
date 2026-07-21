/**
 * Renderer-side Y.Doc replica resolver. The singleton accessor lives in
 * `@brainstorm-os/react-yjs` (`createYDocResolverAccessor`, shared with Journal
 * / Code Editor / Tasks); this wires it to the Notes runtime getter.
 *
 * `contextBridge.exposeInMainWorld` can't structured-clone a Y.Doc across
 * worlds, so the resolver core runs in the renderer over IPC-cloneable
 * primitives (`entities.loadDoc / applyDoc / closeDoc` + `ydoc.onRemote`).
 * Singleton-per-renderer: every `useYDoc(entityId)` shares one refcounted
 * replica.
 */

import { createYDocResolverAccessor } from "@brainstorm-os/react-yjs";
import { getBrainstorm } from "./runtime";

export const getYDocResolverApi = createYDocResolverAccessor(getBrainstorm);
