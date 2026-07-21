/**
 * entity-index — the shared, source-injected vault-entity title + icon
 * index. Verifies the inject → subscribe → resolve → re-fetch lifecycle
 * without any app runtime (the source is a plain fake).
 */

import type { VaultEntity } from "@brainstorm-os/sdk-types";
import { afterEach, expect, it, vi } from "vitest";
import {
	type EntityIndexSource,
	getEntityIcon,
	getEntityTitle,
	setEntityIndexSource,
	subscribeEntityTitles,
} from "./entity-index";

function entity(id: string, props: Record<string, unknown>): VaultEntity {
	return { id, type: "io.test/Thing/v1", properties: props } as unknown as VaultEntity;
}

function makeSource(initial: VaultEntity[]) {
	let current = initial;
	let listeners: Array<() => void> = [];
	const source: EntityIndexSource = {
		list: vi.fn(async () => ({ entities: current })),
		onChange: (listener) => {
			listeners.push(listener);
			return {
				unsubscribe: () => {
					listeners = listeners.filter((l) => l !== listener);
				},
			};
		},
	};
	return {
		source,
		fire: () => {
			for (const l of listeners) l();
		},
		setEntities: (e: VaultEntity[]) => {
			current = e;
		},
	};
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
	setEntityIndexSource(null);
});

it("resolves title + icon from the injected source after a subscriber attaches", async () => {
	const { source } = makeSource([
		entity("e1", { title: "Hello", icon: "🌟" }),
		entity("e2", { name: "Named", icon: { kind: "pack", value: "ph/star", color: "#f00" } }),
	]);
	setEntityIndexSource(source);

	// No fetch until the first subscriber.
	expect(source.list).not.toHaveBeenCalled();
	const unsub = subscribeEntityTitles(() => {});
	expect(source.list).toHaveBeenCalledTimes(1);
	await flush();

	expect(getEntityTitle("e1")).toBe("Hello");
	expect(getEntityTitle("e2")).toBe("Named");
	expect(getEntityIcon("e1")).toEqual({ kind: "emoji", value: "🌟" });
	expect(getEntityIcon("e2")).toEqual({ kind: "pack", value: "ph/star", color: "#f00" });
	unsub();
});

it("returns undefined title for unknown / bare-id entities", async () => {
	const { source } = makeSource([entity("e1", {})]);
	setEntityIndexSource(source);
	const unsub = subscribeEntityTitles(() => {});
	await flush();
	// Entity exists but has no title/name → bare-id fallback surfaces as undefined.
	expect(getEntityTitle("e1")).toBeUndefined();
	// Genuinely unknown id.
	expect(getEntityTitle("nope")).toBeUndefined();
	expect(getEntityIcon("nope")).toBeNull();
	unsub();
});

it("re-fetches and notifies subscribers when the source signals a change", async () => {
	const { source, fire, setEntities } = makeSource([entity("e1", { title: "Before" })]);
	setEntityIndexSource(source);
	const notify = vi.fn();
	const unsub = subscribeEntityTitles(notify);
	await flush();
	expect(getEntityTitle("e1")).toBe("Before");

	setEntities([entity("e1", { title: "After" })]);
	fire();
	await flush();
	expect(getEntityTitle("e1")).toBe("After");
	expect(notify).toHaveBeenCalled();
	unsub();
});
