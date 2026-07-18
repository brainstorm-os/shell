/**
 * DND-6 — pending "Link to note…" queue: the hand-off between the target
 * picker (app side) and the editor's `PendingEntityLinkPlugin`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	_resetPendingEntityLinksForTests,
	drainPendingEntityLinks,
	onPendingEntityLinks,
	queuePendingEntityLinks,
} from "./pending-link";

const LINK = { entityId: "n1", entityType: "brainstorm/Note/v1", label: "Source" };

afterEach(() => {
	_resetPendingEntityLinksForTests();
});

describe("pending entity links (DND-6 link-to-note twin)", () => {
	it("queues per note id and drains once", () => {
		queuePendingEntityLinks("target", [LINK]);
		queuePendingEntityLinks("target", [{ ...LINK, entityId: "n2" }]);
		expect(drainPendingEntityLinks("target").map((l) => l.entityId)).toEqual(["n1", "n2"]);
		expect(drainPendingEntityLinks("target")).toEqual([]);
	});

	it("does not leak into other notes' queues", () => {
		queuePendingEntityLinks("a", [LINK]);
		expect(drainPendingEntityLinks("b")).toEqual([]);
		expect(drainPendingEntityLinks("a")).toHaveLength(1);
	});

	it("notifies a registered listener on enqueue (already-open note case)", () => {
		const listener = vi.fn();
		const off = onPendingEntityLinks("target", listener);
		queuePendingEntityLinks("target", [LINK]);
		expect(listener).toHaveBeenCalledTimes(1);
		off();
		queuePendingEntityLinks("target", [LINK]);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("an empty enqueue is a no-op (no listener churn)", () => {
		const listener = vi.fn();
		onPendingEntityLinks("target", listener);
		queuePendingEntityLinks("target", []);
		expect(listener).not.toHaveBeenCalled();
		expect(drainPendingEntityLinks("target")).toEqual([]);
	});
});
