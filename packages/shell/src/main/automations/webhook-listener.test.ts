import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebhookHit, WebhookTrigger } from "./automations-host";
import {
	WEBHOOK_MAX_BODY_BYTES,
	type WebhookLoopbackListener,
	createWebhookLoopbackListener,
} from "./webhook-listener";

describe("webhook loopback listener (11b.8)", () => {
	let listener: WebhookLoopbackListener | null = null;
	const route: WebhookTrigger = { workflowId: "wf1", routeId: "r1", secret: "s3cr3t-token" };

	afterEach(async () => {
		await listener?.close();
		listener = null;
	});

	async function start(routes: WebhookTrigger[] = [route]): Promise<number> {
		listener = createWebhookLoopbackListener();
		const port = await listener.whenReady();
		listener.register(routes);
		return port;
	}

	it("accepts a POST with the right secret (202) and emits a secret-free hit", async () => {
		const port = await start();
		const hits: WebhookHit[] = [];
		listener?.subscribe((h) => hits.push(h));

		const res = await fetch(`http://127.0.0.1:${port}/wh/r1/s3cr3t-token`, {
			method: "POST",
			body: "payload-body",
			headers: { "x-test": "1" },
		});
		expect(res.status).toBe(202);

		await vi.waitFor(() => expect(hits.length).toBe(1));
		expect(hits[0]).toMatchObject({
			workflowId: "wf1",
			routeId: "r1",
			method: "POST",
			bodyText: "payload-body",
		});
		expect(hits[0]?.headers["x-test"]).toBe("1");
		expect((hits[0] as unknown as { secret?: string }).secret).toBeUndefined();
	});

	it("404s an unknown route and a wrong secret identically (no oracle) and emits nothing", async () => {
		const port = await start();
		const hits: WebhookHit[] = [];
		listener?.subscribe((h) => hits.push(h));

		expect(
			(await fetch(`http://127.0.0.1:${port}/wh/nope/whatever`, { method: "POST" })).status,
		).toBe(404);
		expect(
			(await fetch(`http://127.0.0.1:${port}/wh/r1/wrong-secret`, { method: "POST" })).status,
		).toBe(404);
		expect(hits).toHaveLength(0);
	});

	it("405s a non-POST to a valid route + secret", async () => {
		const port = await start();
		const res = await fetch(`http://127.0.0.1:${port}/wh/r1/s3cr3t-token`);
		expect(res.status).toBe(405);
		expect(res.headers.get("allow")).toBe("POST");
	});

	it("413s an over-cap body", async () => {
		const port = await start();
		const big = "x".repeat(WEBHOOK_MAX_BODY_BYTES + 1024);
		const res = await fetch(`http://127.0.0.1:${port}/wh/r1/s3cr3t-token`, {
			method: "POST",
			body: big,
		});
		expect(res.status).toBe(413);
	});

	it("register replaces the active route set", async () => {
		const port = await start();
		listener?.register([{ workflowId: "wf2", routeId: "r2", secret: "s2" }]);
		// The old route is gone.
		expect(
			(await fetch(`http://127.0.0.1:${port}/wh/r1/s3cr3t-token`, { method: "POST" })).status,
		).toBe(404);
		expect((await fetch(`http://127.0.0.1:${port}/wh/r2/s2`, { method: "POST" })).status).toBe(202);
	});
});
