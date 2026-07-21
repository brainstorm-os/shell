import { AttachmentKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { objectItemToAttachment } from "./object-attachment";

describe("objectItemToAttachment", () => {
	it("maps a dragged object to a pinned-entity attachment", () => {
		expect(
			objectItemToAttachment({ entityId: "ent-1", entityType: "io.b/Note/v1", label: "Roadmap" }),
		).toEqual({
			kind: AttachmentKind.Entity,
			ref: "ent-1",
			label: "Roadmap",
			entityType: "io.b/Note/v1",
		});
	});

	it("omits an empty label and empty entityType (exactOptionalPropertyTypes)", () => {
		expect(objectItemToAttachment({ entityId: "ent-2", entityType: "", label: "   " })).toEqual({
			kind: AttachmentKind.Entity,
			ref: "ent-2",
		});
	});
});
