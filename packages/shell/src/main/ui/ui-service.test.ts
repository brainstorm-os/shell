import { describe, expect, it, vi } from "vitest";
import type { Envelope } from "../../ipc/envelope";
import { BadgeHost } from "./badge-host";
import { UiNotifyHost } from "./notify-host";
import { TrayHost } from "./tray-host";
import { makeUiServiceHandler } from "./ui-service";

function envelope(method: string, app = "io.example.app", ...args: unknown[]): Envelope {
	return { v: 1, msg: "m1", app, service: "ui", method, args, caps: ["notifications.post"] };
}

function handlerWith(host = new UiNotifyHost(), tray = new TrayHost()) {
	return {
		handler: makeUiServiceHandler({ getHost: () => host, getTrayHost: () => tray }),
		host,
		tray,
	};
}

describe("makeUiServiceHandler — notify", () => {
	it("normalises + forwards a notify call to the host, stamping the envelope app", () => {
		const { handler, host } = handlerWith();
		const post = vi
			.spyOn(host, "post")
			.mockReturnValue({ recorded: true, osNotified: false, suppressed: false, deduped: false });

		const result = handler(
			envelope("notify", "io.example.tasks", { title: "Saved", kind: "success" }),
		);

		expect(result).toBeUndefined();
		expect(post).toHaveBeenCalledWith({
			appId: "io.example.tasks",
			title: "Saved",
			kind: "success",
		});
	});

	it("throws Invalid on a malformed payload (no title)", () => {
		const { handler } = handlerWith();
		expect(() => handler(envelope("notify", "a", {}))).toThrowError(
			expect.objectContaining({ name: "Invalid" }),
		);
	});

	it("throws Invalid for an unknown method", () => {
		const { handler } = handlerWith();
		expect(() => handler(envelope("openWindow", "a", { windowId: "w" }))).toThrowError(
			expect.objectContaining({ name: "Invalid" }),
		);
	});
});

describe("makeUiServiceHandler — tray", () => {
	it("publishes a validated section under the envelope app", () => {
		const { handler, tray } = handlerWith();
		const publish = vi.spyOn(tray, "publish");
		const spec = { items: [{ id: "new", label: "New note" }] };

		const result = handler(envelope("tray.publish", "io.example.notes", spec));

		expect(result).toBeUndefined();
		expect(publish).toHaveBeenCalledWith("io.example.notes", spec);
		expect(tray.compose()?.entries).toContainEqual(
			expect.objectContaining({ kind: "item", appId: "io.example.notes", label: "New note" }),
		);
	});

	it("throws Invalid on a malformed tray spec", () => {
		const { handler } = handlerWith();
		expect(() => handler(envelope("tray.publish", "a", { items: [] }))).toThrowError(
			expect.objectContaining({ name: "Invalid" }),
		);
	});

	it("clears the calling app's section", () => {
		const { handler, tray } = handlerWith();
		handler(envelope("tray.publish", "a", { items: [{ id: "x", label: "X" }] }));
		expect(tray.compose()).not.toBeNull();
		handler(envelope("tray.clear", "a"));
		expect(tray.compose()).toBeNull();
	});
});

describe("makeUiServiceHandler — badge (7.14)", () => {
	function badgeHandler() {
		const badge = new BadgeHost();
		const handler = makeUiServiceHandler({
			getHost: () => new UiNotifyHost(),
			getTrayHost: () => new TrayHost(),
			getBadgeHost: () => badge,
		});
		return { handler, badge };
	}

	it("sets a validated badge under the broker-verified envelope app", () => {
		const { handler, badge } = badgeHandler();
		expect(handler(envelope("badge.set", "io.example.chat", { count: 4 }))).toBeUndefined();
		expect(badge.compose()).toEqual([{ appId: "io.example.chat", count: 4 }]);
	});

	it("cannot badge another app's icon — the id is the envelope app, not the payload", () => {
		const { handler, badge } = badgeHandler();
		// A hostile `appId` in the payload is ignored; only envelope.app is used.
		handler(envelope("badge.set", "io.example.chat", { count: 1, appId: "io.example.mailbox" }));
		expect(badge.compose()).toEqual([{ appId: "io.example.chat", count: 1 }]);
	});

	it("a count<=0 set clears the app's badge", () => {
		const { handler, badge } = badgeHandler();
		handler(envelope("badge.set", "a", { count: 3 }));
		handler(envelope("badge.set", "a", { count: 0 }));
		expect(badge.compose()).toEqual([]);
	});

	it("clears the calling app's badge", () => {
		const { handler, badge } = badgeHandler();
		handler(envelope("badge.set", "a", { dot: true }));
		expect(badge.compose()).not.toEqual([]);
		handler(envelope("badge.clear", "a"));
		expect(badge.compose()).toEqual([]);
	});

	it("throws Invalid on a malformed badge spec", () => {
		const { handler } = badgeHandler();
		expect(() => handler(envelope("badge.set", "a", { nope: 1 }))).toThrowError(
			expect.objectContaining({ name: "Invalid" }),
		);
	});

	it("throws Unavailable when no badge host is wired", () => {
		const { handler } = handlerWith();
		expect(() => handler(envelope("badge.set", "a", { count: 1 }))).toThrowError(
			expect.objectContaining({ name: "Unavailable" }),
		);
	});
});

describe("makeUiServiceHandler — openSearch (9.8.9)", () => {
	function searchHandler() {
		const opened: string[] = [];
		const handler = makeUiServiceHandler({
			getHost: () => new UiNotifyHost(),
			getTrayHost: () => new TrayHost(),
			openSearch: (query) => opened.push(query),
		});
		return { handler, opened };
	}

	it("forwards the query to the injected opener", () => {
		const { handler, opened } = searchHandler();
		expect(handler(envelope("openSearch", "io.brainstorm.files", { query: "report" }))).toBe(
			undefined,
		);
		expect(opened).toEqual(["report"]);
	});

	it("degrades a missing / non-string query to an empty palette open", () => {
		const { handler, opened } = searchHandler();
		handler(envelope("openSearch", "a", {}));
		handler(envelope("openSearch", "a", { query: 42 }));
		handler(envelope("openSearch", "a"));
		expect(opened).toEqual(["", "", ""]);
	});

	it("clamps an oversized query instead of pumping it through", () => {
		const { handler, opened } = searchHandler();
		handler(envelope("openSearch", "a", { query: "x".repeat(10_000) }));
		expect(opened[0]?.length).toBe(512);
	});

	it("throws Unavailable when no opener is wired", () => {
		const { handler } = handlerWith();
		expect(() => handler(envelope("openSearch", "a", { query: "q" }))).toThrowError(
			expect.objectContaining({ name: "Unavailable" }),
		);
	});
});
