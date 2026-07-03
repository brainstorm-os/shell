import { afterEach, describe, expect, it } from "vitest";
import { customSchemeRedirectProvider, startLoopbackRedirect } from "./oauth-redirect";

// Every capture opens a real 127.0.0.1 loopback server. A test that ends on a
// non-terminal path (state mismatch, early redirect) can leave it bound, and a
// late `error`/`connection` event then fires after the test env is gone → the
// unhandled error that intermittently failed otherwise-green CI runs. Track
// every capture and close it in afterEach so no server outlives its test.
const open: Array<{ close(): void }> = [];
async function start(opts?: Parameters<typeof startLoopbackRedirect>[0]) {
	const capture = await startLoopbackRedirect(opts);
	open.push(capture);
	return capture;
}
afterEach(() => {
	for (const c of open.splice(0)) {
		try {
			c.close();
		} catch {
			/* already closed on a terminal path — fine */
		}
	}
});

async function hit(redirectUri: string, query: Record<string, string>): Promise<void> {
	const url = new URL(redirectUri);
	for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
	await fetch(url.toString());
}

describe("oauth-redirect — loopback", () => {
	it("binds 127.0.0.1 and resolves with the code on a matching state", async () => {
		const capture = await start();
		expect(capture.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
		const codePromise = capture.waitForCode("state-xyz");
		await hit(capture.redirectUri, { code: "the-code", state: "state-xyz" });
		await expect(codePromise).resolves.toBe("the-code");
	});

	it("rejects on a state mismatch", async () => {
		const capture = await start();
		const codePromise = capture.waitForCode("expected-state");
		// Attach the rejection assertion BEFORE triggering the redirect: the
		// mismatch rejects codePromise during `hit()`'s await, so attaching
		// `.rejects` after would leave a microtask window where the rejection is
		// unhandled — vitest catches that and fails the run (the CI flake).
		const rejected = expect(codePromise).rejects.toThrow(/state mismatch/);
		await hit(capture.redirectUri, { code: "x", state: "attacker-state" });
		await rejected;
	});

	it("times out and closes when no redirect arrives", async () => {
		const capture = await start({ timeoutMs: 50 });
		await expect(capture.waitForCode("s")).rejects.toThrow(/timed out/);
	});

	it("handles a redirect that arrives before waitForCode is called", async () => {
		const capture = await start();
		await hit(capture.redirectUri, { code: "early", state: "s1" });
		await new Promise((r) => setTimeout(r, 20));
		await expect(capture.waitForCode("s1")).resolves.toBe("early");
	});
});

describe("oauth-redirect — custom-scheme fallback", () => {
	it("is wired behind the same interface but not yet implemented", async () => {
		await expect(customSchemeRedirectProvider.start()).rejects.toThrow(/OQ-CN-2/);
	});
});
