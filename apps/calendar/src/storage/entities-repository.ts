/**
 * Calendar events repository over the **shared entities service** — the
 * real `entities.db`. Implements the `EventsRepository` contract the app's
 * call sites depend on. Single type (`brainstorm/Event/v1`).
 *
 * `save` is get-then-create-or-update keyed on `event.id`. The app's domain
 * `createdAt`/`updatedAt` stay in the property bag. Plumbing lives in
 * `@brainstorm-os/sdk/storage-repository`.
 */

import { createEntityRepository } from "@brainstorm-os/sdk/storage-repository";
import type { Event } from "../types/event";
import { parseStoredEvent, serializeEvent } from "./codec";
import type { EventsRepository } from "./repository";
import type { EntitiesService } from "./runtime";

export const EVENT_TYPE = "brainstorm/Event/v1";

function logError(op: string, err: unknown): void {
	console.warn(`[calendar/entities-repo] ${op} failed:`, err);
}

export function createEntitiesRepository(entities: EntitiesService): EventsRepository {
	return createEntityRepository<Event>(entities, {
		type: EVENT_TYPE,
		getId: (e) => e.id,
		toProps: (e) => {
			const { id: _id, ...props } = serializeEvent(e);
			return props;
		},
		fromEntity: (e) => parseStoredEvent({ ...e.properties, id: e.id }),
		log: logError,
	});
}
