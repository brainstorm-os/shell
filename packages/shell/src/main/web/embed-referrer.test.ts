import { EMBEDDER_REFERRER, EMBED_FRAMES, EmbedKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	embedReferrerRewriter,
	installEmbedReferrer,
	needsEmbedderReferrer,
} from "./embed-referrer";
import {
	type HeaderRewriteRequest,
	type HeaderRewriteSession,
	type RequestHeaderRewriter,
	addRequestHeaderRewriter,
	applyRequestHeaderRewriters,
} from "./request-header-rewriters";

const PLAYER = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";
const frame = (url: string): HeaderRewriteRequest => ({ url, resourceType: "subFrame" });

type Listener = Parameters<HeaderRewriteSession["webRequest"]["onBeforeSendHeaders"]>[0];

function fakeSession(): {
	session: HeaderRewriteSession;
	registrations: () => number;
	send: (request: HeaderRewriteRequest, headers: Record<string, string>) => Record<string, string>;
} {
	const listeners: Listener[] = [];
	return {
		session: { webRequest: { onBeforeSendHeaders: (l) => void listeners.push(l) } },
		registrations: () => listeners.length,
		// Electron semantics: only the LAST registered listener is live.
		send: (request, headers) => {
			const live = listeners.at(-1);
			if (!live) return headers;
			let out = headers;
			live({ ...request, requestHeaders: headers }, (response) => {
				out = response.requestHeaders;
			});
			return out;
		},
	};
}

describe("needsEmbedderReferrer", () => {
	it("matches the YouTube player document, with or without a query", () => {
		expect(needsEmbedderReferrer(frame(PLAYER))).toBe(true);
		expect(needsEmbedderReferrer(frame(`${PLAYER}?start=90`))).toBe(true);
	});

	it("ignores every resource type but an iframe document", () => {
		for (const resourceType of [
			"mainFrame",
			"xhr",
			"script",
			"image",
			"media",
			"stylesheet",
			"font",
			"ping",
			"webSocket",
			"other",
			undefined,
		]) {
			expect(
				needsEmbedderReferrer({ url: PLAYER, ...(resourceType ? { resourceType } : {}) }),
				String(resourceType),
			).toBe(false);
		}
	});

	it("ignores other paths on the player origin", () => {
		for (const path of [
			"/",
			"/embed",
			"/embed/",
			"/watch?v=dQw4w9WgXcQ",
			"/youtubei/v1/player",
			"/s/player/x/base.js",
			"/embedded/x",
			"/x/embed/dQw4w9WgXcQ",
		]) {
			expect(needsEmbedderReferrer(frame(`https://www.youtube-nocookie.com${path}`)), path).toBe(
				false,
			);
		}
	});

	it("ignores lookalike, sibling and malformed hosts", () => {
		for (const url of [
			"https://www.youtube-nocookie.com.evil.example/embed/dQw4w9WgXcQ",
			"https://evilwww.youtube-nocookie.com/embed/dQw4w9WgXcQ",
			"https://youtube-nocookie.com/embed/dQw4w9WgXcQ",
			"https://www.youtube.com/embed/dQw4w9WgXcQ",
			"https://m.youtube-nocookie.com/embed/dQw4w9WgXcQ",
			"https://www.youtube-nocookie.com./embed/dQw4w9WgXcQ",
			"https://www.youtube-nocookie.com:8443/embed/dQw4w9WgXcQ",
			"http://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
			"https://user@www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
			"https://www.youtube-nocookie.com@evil.example/embed/dQw4w9WgXcQ",
			"https://evil.example/https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
			"https://evil.example/?u=https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
			"brainstorm://notes/embed/dQw4w9WgXcQ",
			"not a url",
			"",
		]) {
			expect(needsEmbedderReferrer(frame(url)), url).toBe(false);
		}
	});

	it("leaves every other provider's frame untouched", () => {
		for (const [kind, spec] of Object.entries(EMBED_FRAMES)) {
			if (kind === EmbedKind.YouTube) continue;
			expect(spec.embedderReferrerPath, kind).toBeNull();
			for (const path of ["/embed/abc", "/video/123", "/maps?q=x&output=embed", "/player/?url=x"]) {
				expect(needsEmbedderReferrer(frame(`${spec.frameOrigin}${path}`)), `${kind}${path}`).toBe(
					false,
				);
			}
		}
	});
});

describe("embedReferrerRewriter", () => {
	it("sets the fixed embedder origin and changes no other header", () => {
		const headers = { "User-Agent": "UA", Cookie: "a=b", Accept: "text/html" };
		const out = embedReferrerRewriter(frame(PLAYER), headers);
		expect(out).toEqual({ ...headers, Referer: "https://getbrainstorm.online/" });
		expect(EMBEDDER_REFERRER).toBe("https://getbrainstorm.online/");
		expect(headers).not.toHaveProperty("Referer");
	});

	it("replaces a referrer already on the request, whatever its case", () => {
		const out = embedReferrerRewriter(frame(PLAYER), {
			referer: "brainstorm://notes/n_secret-note-id",
			REFERER: "https://private.example/doc",
		});
		expect(out).toEqual({ Referer: EMBEDDER_REFERRER });
	});

	it("returns the same headers object for a request it does not own", () => {
		const headers = { Referer: "https://example.com/" };
		expect(embedReferrerRewriter(frame("https://player.vimeo.com/video/1"), headers)).toBe(headers);
		expect(embedReferrerRewriter({ url: PLAYER, resourceType: "xhr" }, headers)).toBe(headers);
	});
});

describe("request-header rewriter composition", () => {
	const stripCookie: RequestHeaderRewriter = (_request, headers) => {
		const { Cookie: _dropped, ...rest } = headers;
		return rest;
	};

	it("registers ONE listener per session however many rules are added", () => {
		const { session, registrations } = fakeSession();
		addRequestHeaderRewriter(session, stripCookie);
		addRequestHeaderRewriter(session, embedReferrerRewriter);
		addRequestHeaderRewriter(session, (_r, h) => h);
		expect(registrations()).toBe(1);
	});

	it("runs every rule, in order, each on the previous one's result", () => {
		const { session, send } = fakeSession();
		addRequestHeaderRewriter(session, stripCookie);
		addRequestHeaderRewriter(session, embedReferrerRewriter);
		expect(send(frame(PLAYER), { Cookie: "a=b", Accept: "*/*" })).toEqual({
			Accept: "*/*",
			Referer: EMBEDDER_REFERRER,
		});
		expect(send(frame("https://example.com/"), { Cookie: "a=b", Accept: "*/*" })).toEqual({
			Accept: "*/*",
		});
	});

	it("a later rule does not clobber an earlier one, in either order", () => {
		const { session, send } = fakeSession();
		addRequestHeaderRewriter(session, embedReferrerRewriter);
		addRequestHeaderRewriter(session, stripCookie);
		expect(send(frame(PLAYER), { Cookie: "a=b" })).toEqual({ Referer: EMBEDDER_REFERRER });
	});

	it("keeps sessions separate: a rule on one never runs on another", () => {
		const app = fakeSession();
		const browser = fakeSession();
		installEmbedReferrer(app.session);
		addRequestHeaderRewriter(browser.session, stripCookie);
		expect(app.send(frame(PLAYER), {})).toEqual({ Referer: EMBEDDER_REFERRER });
		expect(browser.send(frame(PLAYER), { Accept: "*/*" })).toEqual({ Accept: "*/*" });
		expect(fakeSession().send(frame(PLAYER), {})).toEqual({});
	});

	it("installs the embed rule once per session", () => {
		const { session, registrations, send } = fakeSession();
		installEmbedReferrer(session);
		installEmbedReferrer(session);
		installEmbedReferrer(session);
		expect(registrations()).toBe(1);
		expect(send(frame(PLAYER), {})).toEqual({ Referer: EMBEDDER_REFERRER });
	});

	it("drops a throwing rule's step and still applies the rest", () => {
		const boom: RequestHeaderRewriter = () => {
			throw new Error("rule failed");
		};
		expect(
			applyRequestHeaderRewriters([boom, embedReferrerRewriter], frame(PLAYER), { Accept: "*/*" }),
		).toEqual({ Accept: "*/*", Referer: EMBEDDER_REFERRER });
	});
});
