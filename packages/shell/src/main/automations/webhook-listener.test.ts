import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../storage/registry-repo/connector-webhooks-repo";
import { type WebhookHit, type WebhookRoute, WebhookTargetKind } from "./automations-host";
import {
	WEBHOOK_MAX_BODY_BYTES,
	type WebhookLoopbackListener,
	createWebhookLoopbackListener,
} from "./webhook-listener";

describe("webhook loopback listener (11b.8)", () => {
	let listener: WebhookLoopbackListener | null = null;
	const route: WebhookRoute = {
		routeId: "r1",
		targetKind: WebhookTargetKind.Workflow,
		targetId: "wf1",
		secret: "s3cr3t-token",
	};

	afterEach(async () => {
		await listener?.close();
		listener = null;
	});

	async function start(routes: WebhookRoute[] = [route]): Promise<number> {
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
			targetKind: WebhookTargetKind.Workflow,
			targetId: "wf1",
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
		listener?.register([
			{ routeId: "r2", targetKind: WebhookTargetKind.Workflow, targetId: "wf2", secret: "s2" },
		]);
		// The old route is gone.
		expect(
			(await fetch(`http://127.0.0.1:${port}/wh/r1/s3cr3t-token`, { method: "POST" })).status,
		).toBe(404);
		expect((await fetch(`http://127.0.0.1:${port}/wh/r2/s2`, { method: "POST" })).status).toBe(202);
	});

	// ─── Connector-6: hash-custody connector routes ─────────────────────────

	const connectorSecret = "conn-s3cr3t-0123456789abcdefghij";
	const connectorRoute: WebhookRoute = {
		routeId: "cw1",
		targetKind: WebhookTargetKind.ConnectorSync,
		targetId: "map1",
		secretSha256: sha256Hex(connectorSecret),
	};

	it("authenticates a connector route against its SHA-256 digest and emits a connector-sync hit", async () => {
		const port = await start([connectorRoute]);
		const hits: WebhookHit[] = [];
		listener?.subscribe((h) => hits.push(h));

		const res = await fetch(`http://127.0.0.1:${port}/wh/cw1/${connectorSecret}`, {
			method: "POST",
			body: "ignored-doorbell-payload",
		});
		expect(res.status).toBe(202);
		await vi.waitFor(() => expect(hits.length).toBe(1));
		expect(hits[0]).toMatchObject({
			targetKind: WebhookTargetKind.ConnectorSync,
			targetId: "map1",
			routeId: "cw1",
		});
	});

	it("404s a wrong secret on a connector route (no oracle) — the digest itself never authenticates", async () => {
		const port = await start([connectorRoute]);
		const hits: WebhookHit[] = [];
		listener?.subscribe((h) => hits.push(h));

		expect((await fetch(`http://127.0.0.1:${port}/wh/cw1/wrong`, { method: "POST" })).status).toBe(
			404,
		);
		// Presenting the stored digest as the secret must fail: it hashes to a
		// different value (an attacker reading registry.db gains nothing).
		expect(
			(
				await fetch(`http://127.0.0.1:${port}/wh/cw1/${sha256Hex(connectorSecret)}`, {
					method: "POST",
				})
			).status,
		).toBe(404);
		expect(hits).toHaveLength(0);
	});

	it("fail-closed: a route with neither secret form authenticates nothing", async () => {
		const port = await start([
			{ routeId: "r9", targetKind: WebhookTargetKind.Workflow, targetId: "wf9" },
		]);
		expect((await fetch(`http://127.0.0.1:${port}/wh/r9/`, { method: "POST" })).status).toBe(404);
		expect((await fetch(`http://127.0.0.1:${port}/wh/r9/undefined`, { method: "POST" })).status).toBe(
			404,
		);
	});
});
