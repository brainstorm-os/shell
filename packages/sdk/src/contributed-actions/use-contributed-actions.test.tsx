// @vitest-environment jsdom
import {
	ActionTrustTier,
	type ContributedAction,
	ContributedVerb,
	contributedActionId,
} from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContributedActionsRuntime } from "./types";
import { type UseContributedActionsResult, useContributedActions } from "./use-contributed-actions";

function action(over: Partial<ContributedAction> & { appId: string }): ContributedAction {
	const verb = over.verb ?? ContributedVerb.Process;
	return {
		id: contributedActionId(verb, over.kind, over.appId),
		verb,
		label: over.label ?? "Do thing",
		group: over.group ?? "actions",
		priority: over.priority ?? "secondary",
		trustTier: over.trustTier ?? ActionTrustTier.Trusted,
		appLabel: over.appLabel ?? over.appId,
		...over,
	};
}

let container: HTMLDivElement;
let root: Root;
let latest: UseContributedActionsResult | null = null;

function Harness({ runtime }: { runtime: ContributedActionsRuntime }) {
	latest = useContributedActions({
		runtime,
		target: { entityId: "ent_1", entityType: "io.example/Note/v1" },
		verbs: [ContributedVerb.Process, ContributedVerb.Share],
	});
	return null;
}

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	latest = null;
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

describe("useContributedActions", () => {
	it("fetches, then exposes grouped + flat results", async () => {
		const suggestActions = vi
			.fn()
			.mockResolvedValue([action({ appId: "io.example.agent", kind: "summarize" })]);
		const runtime: ContributedActionsRuntime = {
			services: { intents: { suggestActions } },
		};
		await act(async () => {
			root.render(<Harness runtime={runtime} />);
		});
		expect(suggestActions).toHaveBeenCalledOnce();
		expect(latest?.actions).toHaveLength(1);
		expect(latest?.groups[0]?.inline[0]?.appId).toBe("io.example.agent");
	});

	it("degrades to empty when the runtime has no suggestActions surface", async () => {
		const runtime: ContributedActionsRuntime = { services: { intents: {} } };
		await act(async () => {
			root.render(<Harness runtime={runtime} />);
		});
		expect(latest?.actions).toEqual([]);
		expect(latest?.groups).toEqual([]);
	});

	it("fails soft to empty when the lookup throws", async () => {
		const runtime: ContributedActionsRuntime = {
			services: { intents: { suggestActions: vi.fn().mockRejectedValue(new Error("boom")) } },
		};
		await act(async () => {
			root.render(<Harness runtime={runtime} />);
		});
		expect(latest?.actions).toEqual([]);
	});
});
