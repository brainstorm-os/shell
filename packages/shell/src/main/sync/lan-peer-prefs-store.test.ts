import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LanDialMode } from "./lan-dial-coordinator";
import { LanPeerPrefsStore, defaultLanPeerPrefs, lanPeerPrefsPath } from "./lan-peer-prefs-store";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "bs-lan-peer-prefs-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const store = () => new LanPeerPrefsStore({ path: lanPeerPrefsPath(dir) });

describe("LanPeerPrefsStore", () => {
	it("defaults to Off with no address — the feature is inert until asked for", async () => {
		expect(defaultLanPeerPrefs()).toEqual({ mode: LanDialMode.Off, manualUrl: null });
		expect(await store().load()).toEqual({ mode: LanDialMode.Off, manualUrl: null });
	});

	it("persists a mode across instances", async () => {
		await store().setMode(LanDialMode.Auto);
		expect((await store().load()).mode).toBe(LanDialMode.Auto);
	});

	it("keeps a stored address across a mode flip so the user does not retype it", async () => {
		const s = store();
		await s.setManualAddress("192.168.1.20:51820");
		await s.setMode(LanDialMode.Auto);
		expect((await store().load()).manualUrl).toBe("ws://192.168.1.20:51820");
	});

	it("normalises a typed address to a ws:// URL", async () => {
		const saved = await store().setManualAddress("  192.168.1.20:51820 ");
		expect(saved?.manualUrl).toBe("ws://192.168.1.20:51820");
	});

	it("REFUSES an address that does not validate rather than storing it", async () => {
		const s = store();
		expect(await s.setManualAddress("evil.example.com:80")).toBeNull();
		expect(await s.setManualAddress("8.8.8.8:80")).toBeNull();
		// Nothing was written: a stored bad address looks exactly like the bug
		// this whole rung exists to fix, a dialer that silently never dials.
		expect((await store().load()).manualUrl).toBeNull();
	});

	it("clears with null", async () => {
		const s = store();
		await s.setManualAddress("10.0.0.4:9000");
		expect((await s.setManualAddress(null))?.manualUrl).toBeNull();
	});

	it("re-validates on read, so a hand-edited file cannot smuggle an address in", async () => {
		writeFileSync(
			lanPeerPrefsPath(dir),
			JSON.stringify({ mode: LanDialMode.Manual, manualUrl: "ws://8.8.8.8:80" }),
		);
		const prefs = await store().load();
		expect(prefs.mode).toBe(LanDialMode.Manual);
		expect(prefs.manualUrl).toBeNull();
	});

	it("falls back to Off on an unparseable file", async () => {
		writeFileSync(lanPeerPrefsPath(dir), "{ not json");
		expect(await store().load()).toEqual({ mode: LanDialMode.Off, manualUrl: null });
	});

	it("falls back to Off on an unrecognised mode", async () => {
		writeFileSync(lanPeerPrefsPath(dir), JSON.stringify({ mode: "everything", manualUrl: null }));
		expect((await store().load()).mode).toBe(LanDialMode.Off);
	});

	it("single-flights a concurrent first load", async () => {
		const s = store();
		const [a, b] = await Promise.all([s.load(), s.load()]);
		expect(a).toBe(b);
	});
});
