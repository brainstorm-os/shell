// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { openExternalUrl } from "./open-external";
import { dismissToast, getSnapshot } from "./toasts";

function stubDispatch(result: unknown): ReturnType<typeof vi.fn> {
	const dispatch = vi.fn().mockResolvedValue(result);
	(window as unknown as { brainstorm: unknown }).brainstorm = { intents: { dispatch } };
	return dispatch;
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("openExternalUrl", () => {
	afterEach(() => {
		for (const toast of getSnapshot()) dismissToast(toast.id);
		vi.restoreAllMocks();
	});

	it("dispatches the open intent for the url", async () => {
		const dispatch = stubDispatch({ handled: true, handler: { appId: "browser" } });
		openExternalUrl("https://example.com/x");
		await flush();
		expect(dispatch).toHaveBeenCalledWith({
			verb: "open",
			payload: { url: "https://example.com/x" },
		});
	});

	it("surfaces an explained refusal as a toast", async () => {
		stubDispatch({ handled: false, reason: "no-handler", message: "you blocked opening it" });
		const before = getSnapshot().length;
		openExternalUrl("https://example.com/refused");
		await flush();
		const toasts = getSnapshot();
		expect(toasts.length).toBe(before + 1);
		expect(toasts[toasts.length - 1]?.body).toBe("you blocked opening it");
	});

	it("stays quiet when the user cancelled the picker", async () => {
		stubDispatch({ handled: false, reason: "cancelled", message: "cancelled" });
		const before = getSnapshot().length;
		openExternalUrl("https://example.com/cancelled");
		await flush();
		expect(getSnapshot().length).toBe(before);
	});
});
