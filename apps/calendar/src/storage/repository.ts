/**
 * `EventsRepository` — the storage contract the app's data layer is written
 * against. Implemented by `createEntitiesRepository` (the shared
 * `entities.db` store); the renderer call sites depend only on this type.
 */

import type { SingleEntityRepository } from "@brainstorm-os/sdk/storage-repository";
import type { Event } from "../types/event";

export type EventsRepository = SingleEntityRepository<Event>;
