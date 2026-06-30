/**
 * Auto-share reactor (Collab-C5, design 71) — flow-2 trigger logic.
 *
 * Pins the create-hook decisions: a Message in a shared channel cascades; a
 * ruleless type, a parent-less child, a non-Create verb, and a no-vault state
 * all no-op; and an async cascade failure is contained (never escapes the
 * fire-and-forget emitter). The engine is a spy — the cascade crypto itself is
 * proven in `sharing-engine-collection.test.ts`.
 */

import { EntityEventVerb, MESSAGE_TYPE_URL } from "@brainstorm/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { EntityChangeEmitter } from "../entities/entity-change-emitter";
import {
	type AutoShareReactorDeps,
	createAutoShareReactor,
	reactToEntityCreate,
} from "./auto-share-reactor";
import type { SharingEngine } from "./sharing-engine";

const CHANNEL_TYPE = "io.brainstorm.chat/Channel/v1";

function spyEngine(impl?: (childId: string, type: string, parentId: string) => Promise<number>) {
	const autoShareNewChild = vi.fn(impl ?? (async () => 1));
	return { engine: { autoShareNewChild } as unknown as SharingEngine, autoShareNewChild };
}

function deps(
	over: Partial<AutoShareReactorDeps> & Pick<AutoShareReactorDeps, "getEngine">,
): AutoShareReactorDeps {
	return {
		readEntityProperties: async () => ({ conversation: "chan_1" }),
		...over,
	};
}

describe("reactToEntityCreate", () => {
	it("cascades a Message that names its channel", async () => {
		const { engine, autoShareNewChild } = spyEngine();
		await reactToEntityCreate(
			{ verb: EntityEventVerb.Create, entityId: "msg_1", type: MESSAGE_TYPE_URL },
			deps({
				getEngine: () => engine,
				readEntityProperties: async () => ({ conversation: "chan_1" }),
			}),
		);
		expect(autoShareNewChild).toHaveBeenCalledWith("msg_1", MESSAGE_TYPE_URL, "chan_1");
	});

	it("ignores a type with no containment rule", async () => {
		const { engine, autoShareNewChild } = spyEngine();
		await reactToEntityCreate(
			{ verb: EntityEventVerb.Create, entityId: "n1", type: "brainstorm/Note/v1" },
			deps({ getEngine: () => engine }),
		);
		expect(autoShareNewChild).not.toHaveBeenCalled();
	});

	it("ignores a child that names no container", async () => {
		const { engine, autoShareNewChild } = spyEngine();
		await reactToEntityCreate(
			{ verb: EntityEventVerb.Create, entityId: "msg_orphan", type: MESSAGE_TYPE_URL },
			deps({ getEngine: () => engine, readEntityProperties: async () => ({}) }),
		);
		expect(autoShareNewChild).not.toHaveBeenCalled();
	});

	it("no-ops when no vault session is open", async () => {
		await expect(
			reactToEntityCreate(
				{ verb: EntityEventVerb.Create, entityId: "msg_1", type: MESSAGE_TYPE_URL },
				deps({ getEngine: () => null }),
			),
		).resolves.toBeUndefined();
	});

	it("ignores a Channel create itself (a container is not its own child)", async () => {
		const { engine, autoShareNewChild } = spyEngine();
		await reactToEntityCreate(
			{ verb: EntityEventVerb.Create, entityId: "chan_1", type: CHANNEL_TYPE },
			deps({ getEngine: () => engine }),
		);
		expect(autoShareNewChild).not.toHaveBeenCalled();
	});
});

describe("createAutoShareReactor — subscription + error containment", () => {
	it("dispatches Create but not Update/Delete", async () => {
		const emitter = new EntityChangeEmitter();
		const { engine, autoShareNewChild } = spyEngine();
		const off = createAutoShareReactor(emitter, {
			getEngine: () => engine,
			readEntityProperties: async () => ({ conversation: "chan_1" }),
		});

		emitter.emit({ verb: EntityEventVerb.Update, entityId: "msg_1", type: MESSAGE_TYPE_URL });
		emitter.emit({ verb: EntityEventVerb.Create, entityId: "msg_1", type: MESSAGE_TYPE_URL });
		await new Promise((r) => setTimeout(r, 0));

		expect(autoShareNewChild).toHaveBeenCalledTimes(1);
		off();
	});

	it("contains an async cascade failure (never an unhandled rejection)", async () => {
		const emitter = new EntityChangeEmitter();
		const { engine } = spyEngine(async () => {
			throw new Error("relay down");
		});
		const onError = vi.fn();
		const off = createAutoShareReactor(emitter, {
			getEngine: () => engine,
			readEntityProperties: async () => ({ conversation: "chan_1" }),
			onError,
		});

		emitter.emit({ verb: EntityEventVerb.Create, entityId: "msg_1", type: MESSAGE_TYPE_URL });
		await new Promise((r) => setTimeout(r, 0));

		expect(onError).toHaveBeenCalledTimes(1);
		off();
	});

	it("the disposer unsubscribes", async () => {
		const emitter = new EntityChangeEmitter();
		const { engine, autoShareNewChild } = spyEngine();
		const off = createAutoShareReactor(emitter, {
			getEngine: () => engine,
			readEntityProperties: async () => ({ conversation: "chan_1" }),
		});
		off();
		emitter.emit({ verb: EntityEventVerb.Create, entityId: "msg_1", type: MESSAGE_TYPE_URL });
		await new Promise((r) => setTimeout(r, 0));
		expect(autoShareNewChild).not.toHaveBeenCalled();
	});
});
