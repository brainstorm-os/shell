/**
 * The one entities repository every importer writes through.
 *
 * Importers write rows directly (the privileged seeder path), and their keys
 * come from the source file: a CSV header, a mapping edit, Markdown
 * frontmatter, a Notion or Anytype property name. A reserved key landing
 * there would forge host-owned state — `agentProvenance` reads back as
 * "Created by <trusted agent>". So reserved keys are stripped here, on every
 * create and update, rather than per importer.
 */

import { stripReservedProperties } from "@brainstorm-os/sdk-types";
import {
	type CreateEntityInput,
	EntitiesRepository,
	type EntityRow,
} from "../storage/entities-repo";

export class ImportEntitiesRepository extends EntitiesRepository {
	override create(input: CreateEntityInput): EntityRow {
		return super.create({ ...input, properties: stripReservedProperties(input.properties) });
	}

	override update(id: string, patch: Record<string, unknown>, now: number): EntityRow | null {
		return super.update(id, stripReservedProperties(patch), now);
	}
}
