import { describe, expect, it } from "vitest";
import {
	EMBED_PROVIDERS,
	EmbedAspect,
	EmbedKind,
	EmbedLoadPolicy,
	type EmbedProviderKind,
	classifyEmbed,
	classifyUrl,
	faviconUrl,
	isLoneUrl,
	parseHttpUrl,
	safeExternalHref,
} from "./embed-providers";

const YT = "dQw4w9WgXcQ";
const SPOTIFY_ID = "4cOdK2wGLETKBW3PvgPWqT";

/** One canonical share URL per provider → the exact iframe src it must
 *  produce. Doubles as the fixture for the catalogue invariants below. */
const CANONICAL: Readonly<Record<EmbedProviderKind, { url: string; embedUrl: string }>> = {
	[EmbedKind.YouTube]: {
		url: `https://www.youtube.com/watch?v=${YT}`,
		embedUrl: `https://www.youtube-nocookie.com/embed/${YT}`,
	},
	[EmbedKind.Vimeo]: {
		url: "https://vimeo.com/123456789",
		embedUrl: "https://player.vimeo.com/video/123456789?dnt=1",
	},
	[EmbedKind.Loom]: {
		url: "https://www.loom.com/share/0281766fa2d04bb788eaf19e65135184",
		embedUrl: "https://www.loom.com/embed/0281766fa2d04bb788eaf19e65135184",
	},
	[EmbedKind.Figma]: {
		url: "https://www.figma.com/design/AbCdEf0123456789abcdef/My-File?node-id=12-34&t=tracking",
		embedUrl:
			"https://www.figma.com/embed?embed_host=brainstorm&url=https%3A%2F%2Fwww.figma.com%2Fdesign%2FAbCdEf0123456789abcdef%2FMy-File%3Fnode-id%3D12-34",
	},
	[EmbedKind.CodeSandbox]: {
		url: "https://codesandbox.io/s/cool-sandbox-x1y2z",
		embedUrl: "https://codesandbox.io/embed/cool-sandbox-x1y2z",
	},
	[EmbedKind.GoogleMaps]: {
		url: "https://www.google.com/maps/place/Eiffel+Tower/@48.8583701,2.2944813,17z/data=!3m1!4b1",
		embedUrl: "https://www.google.com/maps?q=Eiffel+Tower&z=17&output=embed",
	},
	[EmbedKind.OpenStreetMap]: {
		url: "https://www.openstreetmap.org/?mlat=52.5&mlon=13.4#map=10/52.5/13.4",
		embedUrl:
			"https://www.openstreetmap.org/export/embed.html?bbox=12.872656%2C52.25923%2C13.927344%2C52.74077&marker=52.5%2C13.4&layer=mapnik",
	},
	[EmbedKind.Spotify]: {
		url: `https://open.spotify.com/track/${SPOTIFY_ID}?si=abcdef`,
		embedUrl: `https://open.spotify.com/embed/track/${SPOTIFY_ID}`,
	},
	[EmbedKind.SoundCloud]: {
		url: "https://soundcloud.com/some-artist/some-track?utm_source=clipboard",
		embedUrl:
			"https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fsome-artist%2Fsome-track&auto_play=false&hide_related=true&show_comments=false&visual=false",
	},
	[EmbedKind.CodePen]: {
		url: "https://codepen.io/some-user/pen/abcXYZ",
		embedUrl: "https://codepen.io/some-user/embed/abcXYZ?default-tab=result",
	},
	[EmbedKind.Miro]: {
		url: "https://miro.com/app/board/uXjVO1a2b3c=/?share_link_id=123",
		embedUrl: "https://miro.com/app/live-embed/uXjVO1a2b3c=/?embedMode=view_only_without_ui",
	},
};

const PROVIDER_KINDS = Object.keys(EMBED_PROVIDERS) as EmbedProviderKind[];

function expectBookmark(url: string): void {
	const c = classifyUrl(url);
	expect(c?.kind ?? EmbedKind.Bookmark, url).toBe(EmbedKind.Bookmark);
	expect(c?.embedUrl ?? null, url).toBeNull();
	expect(classifyEmbed(url), url).toBeNull();
}

describe("parseHttpUrl", () => {
	it("accepts http(s) and infers a missing scheme", () => {
		expect(parseHttpUrl("https://example.com")?.hostname).toBe("example.com");
		expect(parseHttpUrl("example.com/x")?.protocol).toBe("https:");
	});

	it("rejects non-http schemes, junk, and schemeless single tokens", () => {
		expect(parseHttpUrl("javascript:alert(1)")).toBeNull();
		expect(parseHttpUrl("ftp://example.com")).toBeNull();
		expect(parseHttpUrl("not a url")).toBeNull();
		expect(parseHttpUrl("localhost")).toBeNull();
		expect(parseHttpUrl("")).toBeNull();
	});
});

describe("safeExternalHref", () => {
	it("passes http(s) and nothing else", () => {
		expect(safeExternalHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
		for (const hostile of [
			"javascript:alert(1)",
			"JaVaScRiPt:alert(1)",
			" javascript:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"vbscript:msgbox(1)",
			"file:///etc/passwd",
			"blob:https://example.com/uuid",
			"",
		]) {
			expect(safeExternalHref(hostile), hostile).toBeNull();
		}
	});

	it("never yields a script-scheme href even when a scheme-less prefix parses", () => {
		const href = safeExternalHref("javascript://example.com/%0aalert(1)");
		expect(href).toBeNull();
	});
});

describe("isLoneUrl", () => {
	it("is true only for a single bare URL", () => {
		expect(isLoneUrl("https://a.com")).toBe(true);
		expect(isLoneUrl("  a.com/path  ")).toBe(true);
		expect(isLoneUrl("see https://a.com now")).toBe(false);
		expect(isLoneUrl("hello")).toBe(false);
	});
});

describe("classifyUrl — provider mapping", () => {
	it("maps each provider's canonical URL to its exact embed URL", () => {
		for (const kind of PROVIDER_KINDS) {
			const { url, embedUrl } = CANONICAL[kind];
			const c = classifyUrl(url);
			expect(c?.kind, url).toBe(kind);
			expect(c?.embedUrl, url).toBe(embedUrl);
		}
	});

	it("maps YouTube watch / short / youtu.be / shorts / live to a nocookie embed", () => {
		for (const u of [
			`https://www.youtube.com/watch?v=${YT}`,
			`https://youtu.be/${YT}`,
			`https://www.youtube.com/embed/${YT}`,
			`https://youtube.com/shorts/${YT}`,
			`https://m.youtube.com/live/${YT}`,
			`https://www.youtube.com/watch?list=PL123&v=${YT}&feature=share`,
			`HTTPS://WWW.YouTube.COM/watch?v=${YT}`,
			`youtube.com/watch?v=${YT}`,
		]) {
			const c = classifyUrl(u);
			expect(c?.kind, u).toBe(EmbedKind.YouTube);
			expect(c?.embedUrl, u).toBe(`https://www.youtube-nocookie.com/embed/${YT}`);
		}
	});

	it("carries a YouTube start time as a re-serialised integer, nothing else", () => {
		expect(classifyUrl(`https://youtu.be/${YT}?t=90s&si=track`)?.embedUrl).toBe(
			`https://www.youtube-nocookie.com/embed/${YT}?start=90`,
		);
		expect(classifyUrl(`https://youtu.be/${YT}?t=1m30s`)?.embedUrl).toBe(
			`https://www.youtube-nocookie.com/embed/${YT}`,
		);
		expect(classifyUrl(`https://youtu.be/${YT}?t=9"onload="x`)?.embedUrl).toBe(
			`https://www.youtube-nocookie.com/embed/${YT}`,
		);
	});

	it("keeps a Vimeo unlisted hash and always opts out of tracking", () => {
		expect(classifyUrl("https://vimeo.com/123456789/abcdef0123")?.embedUrl).toBe(
			"https://player.vimeo.com/video/123456789?h=abcdef0123&dnt=1",
		);
		expectBookmark("https://vimeo.com/channels/staffpicks");
		expectBookmark("https://vimeo.com/123456789/not-a-hash!");
	});

	it("maps Google Maps place / search / viewport / ?q URLs to the keyless embed", () => {
		const cases: Array<[string, string]> = [
			[
				"https://www.google.com/maps/search/coffee+near+me/@52.52,13.405,14z",
				"https://www.google.com/maps?q=coffee+near+me&z=14&output=embed",
			],
			[
				"https://www.google.com/maps/@52.52,13.405,12.5z",
				"https://www.google.com/maps?q=52.52%2C13.405&z=12&output=embed",
			],
			[
				"https://maps.google.com/?q=Brandenburg%20Gate",
				"https://www.google.com/maps?q=Brandenburg+Gate&z=15&output=embed",
			],
			[
				"https://maps.google.com/maps?q=1600+Amphitheatre+Parkway",
				"https://www.google.com/maps?q=1600+Amphitheatre+Parkway&z=15&output=embed",
			],
		];
		for (const [url, embedUrl] of cases) {
			const c = classifyUrl(url);
			expect(c?.kind, url).toBe(EmbedKind.GoogleMaps);
			expect(c?.embedUrl, url).toBe(embedUrl);
		}
	});

	it("leaves Google Maps short links, directions and non-map Google pages as bookmarks", () => {
		for (const u of [
			"https://maps.app.goo.gl/AbCdEf123",
			"https://goo.gl/maps/AbCdEf123",
			"https://www.google.com/maps/dir/Berlin/Hamburg",
			"https://www.google.com/maps",
			"https://www.google.com/search?q=maps",
			"https://www.google.com/url?q=https://evil.example",
			"https://www.google.com/maps/../url?q=https://evil.example",
			"https://www.google.com/maps/@999,999,15z",
			"https://www.google.de/maps/place/Berlin",
			"https://docs.google.com/maps/place/Berlin",
		]) {
			expectBookmark(u);
		}
	});

	it("neutralises a hostile Google Maps query into one encoded q value", () => {
		const c = classifyUrl(
			"https://www.google.com/maps/place/x%26output%3Dsvembed%26pb%3Devil%23frag%0d%0aSet-Cookie:a/@1,2,3z",
		);
		expect(c?.kind).toBe(EmbedKind.GoogleMaps);
		const embed = new URL(c?.embedUrl ?? "");
		expect(embed.origin).toBe("https://www.google.com");
		expect(embed.pathname).toBe("/maps");
		expect([...embed.searchParams.keys()]).toEqual(["q", "z", "output"]);
		expect(embed.searchParams.get("output")).toBe("embed");
		expect(embed.searchParams.get("q")).toBe("x&output=svembed&pb=evil#fragSet-Cookie:a");
		expect(embed.hash).toBe("");
		expectBookmark(`https://www.google.com/maps/place/${"a".repeat(201)}`);
		expectBookmark("https://www.google.com/maps/place/%E0%A4%A");
	});

	it("maps OpenStreetMap map-hash / marker / embed URLs and rejects the rest", () => {
		const hashOnly = classifyUrl("https://www.openstreetmap.org/#map=12/48.8566/2.3522");
		expect(hashOnly?.kind).toBe(EmbedKind.OpenStreetMap);
		const box = new URL(hashOnly?.embedUrl ?? "").searchParams.get("bbox")?.split(",").map(Number);
		expect(box).toHaveLength(4);
		const [minLon, minLat, maxLon, maxLat] = box as [number, number, number, number];
		expect(minLon).toBeLessThan(2.3522);
		expect(maxLon).toBeGreaterThan(2.3522);
		expect(minLat).toBeLessThan(48.8566);
		expect(maxLat).toBeGreaterThan(48.8566);
		expect(new URL(hashOnly?.embedUrl ?? "").searchParams.has("marker")).toBe(false);

		expect(
			classifyUrl("https://www.openstreetmap.org/export/embed.html?bbox=13.3,52.4,13.5,52.6&x=y")
				?.embedUrl,
		).toBe(
			"https://www.openstreetmap.org/export/embed.html?bbox=13.3%2C52.4%2C13.5%2C52.6&layer=mapnik",
		);

		const polar = classifyUrl("https://openstreetmap.org/#map=0/89.9/179.9");
		const polarBox = new URL(polar?.embedUrl ?? "").searchParams.get("bbox")?.split(",").map(Number);
		for (const [i, limit] of [180, 85.0511, 180, 85.0511].entries()) {
			expect(Math.abs(polarBox?.[i] ?? Number.NaN)).toBeLessThanOrEqual(limit);
		}

		for (const u of [
			"https://www.openstreetmap.org/",
			"https://www.openstreetmap.org/node/123456",
			"https://www.openstreetmap.org/#map=12/abc/def",
			"https://www.openstreetmap.org/#map=12/91/0",
			"https://www.openstreetmap.org/export/embed.html?bbox=1,2,3",
			"https://www.openstreetmap.org/export/embed.html?bbox=1,2,3,javascript:alert(1)",
			"https://tile.openstreetmap.org/#map=12/48.8/2.3",
		]) {
			expectBookmark(u);
		}
	});

	it("sizes Spotify and SoundCloud by single item vs list", () => {
		expect(classifyUrl(`https://open.spotify.com/track/${SPOTIFY_ID}`)?.aspect).toBe(
			EmbedAspect.Audio,
		);
		const playlist = classifyUrl(`https://open.spotify.com/intl-de/playlist/${SPOTIFY_ID}`);
		expect(playlist?.aspect).toBe(EmbedAspect.AudioList);
		expect(playlist?.embedUrl).toBe(`https://open.spotify.com/embed/playlist/${SPOTIFY_ID}`);
		expect(classifyUrl("https://soundcloud.com/some-artist/sets/an-album")?.aspect).toBe(
			EmbedAspect.AudioList,
		);
		expect(classifyUrl("https://soundcloud.com/some-artist/sets/an-album")?.embedUrl).toContain(
			"url=https%3A%2F%2Fsoundcloud.com%2Fsome-artist%2Fsets%2Fan-album&",
		);
	});

	it("rejects provider URLs whose shape or id is not the expected one", () => {
		for (const u of [
			"https://www.youtube.com/watch?v=short",
			`https://www.youtube.com/watch?v=${YT}%22%3E%3Cscript%3E`,
			`https://www.youtube.com/embed/${YT}/extra`,
			"https://www.youtube.com/redirect?q=https://evil.example",
			"https://www.youtube.com/@some-channel",
			"https://www.loom.com/share/../../evil",
			"https://www.loom.com/looms/videos",
			"https://www.figma.com/",
			"https://www.figma.com/community/file/123456",
			"https://www.figma.com/file/a%2F..%2F..%2Fevil/x",
			"https://codesandbox.io/s/a/b/c",
			"https://codesandbox.io/dashboard",
			`https://open.spotify.com/track/${SPOTIFY_ID}x`,
			`https://open.spotify.com/user/${SPOTIFY_ID}`,
			`https://open.spotify.com/track/${SPOTIFY_ID}/extra`,
			"https://soundcloud.com/discover/sets",
			"https://soundcloud.com/some-artist",
			"https://soundcloud.com/some-artist/sets",
			"https://soundcloud.com/some-artist/some%2Ftrack",
			"https://codepen.io/some-user",
			"https://codepen.io/some-user/pens/public",
			"https://codepen.io/some-user/pen/ab<c",
			"https://miro.com/app/dashboard/",
			"https://miro.com/app/board/x/",
			"https://miro.com/app/board/uXjVO1a2b3c==/",
		]) {
			expectBookmark(u);
		}
	});

	it("keeps script-widget providers (X, Gist) and the never-list as bookmark cards", () => {
		for (const u of [
			"https://x.com/someone/status/1234567890123456789",
			"https://twitter.com/someone/status/1234567890123456789",
			"https://platform.twitter.com/embed/Tweet.html?id=1234567890123456789",
			"https://gist.github.com/someone/0123456789abcdef0123456789abcdef",
			"https://gist.github.com/someone/0123456789abcdef0123456789abcdef.js",
			"https://www.instagram.com/p/AbCdEf/",
			"https://www.facebook.com/someone/posts/123",
		]) {
			expectBookmark(u);
		}
	});

	it("falls back to a bookmark for everything else", () => {
		const c = classifyUrl("https://example.com/article");
		expect(c?.kind).toBe(EmbedKind.Bookmark);
		expect(c?.embedUrl).toBeNull();
		expect(c?.host).toBe("example.com");
	});

	it("strips www from the displayed host", () => {
		expect(classifyUrl("https://www.example.com")?.host).toBe("example.com");
	});

	it("returns null for an unparseable input", () => {
		expect(classifyUrl("nonsense")).toBeNull();
	});
});

describe("classifyUrl — host allowlist attacks", () => {
	const watch = `/watch?v=${YT}`;

	it("never embeds a lookalike, suffix, prefix or subdomain host", () => {
		for (const host of [
			"youtube.com.evil.example",
			"www.youtube.com.evil.example",
			"evilyoutube.com",
			"notyoutube.com",
			"youtube.com-evil.example",
			"youtube.co",
			"youtube.com.",
			"www.youtube.com.",
			"evil.www.youtube.com",
			"attacker.youtube.com",
			"youtube-nocookie.com.evil.example",
			"xn--yutube-wqf.com",
			"yоutube.com",
			"youtubе.com",
			"www.youtube.com%2eevil.example",
			"127.0.0.1",
			"[::1]",
		]) {
			expectBookmark(`https://${host}${watch}`);
		}
		for (const u of [
			"https://evil.figma.com/file/AbCdEf0123456789abcdef/x",
			"https://figma.com.evil.example/file/AbCdEf0123456789abcdef/x",
			"https://evilvimeo.com/123456789",
			"https://codesandbox.io.evil.example/s/abc",
			"https://www.google.com.evil.example/maps/place/Berlin",
			"https://maps.google.com.evil.example/?q=Berlin",
			"https://openstreetmap.org.evil.example/#map=12/48.8/2.3",
			`https://open.spotify.com.evil.example/track/${SPOTIFY_ID}`,
			`https://evil-open.spotify.com/track/${SPOTIFY_ID}`,
			"https://soundcloud.com.evil.example/a/b",
			"https://codepen.io.evil.example/u/pen/abcXYZ",
			"https://miro.com.evil.example/app/board/uXjVO1a2b3c=/",
		]) {
			expectBookmark(u);
		}
	});

	it("never embeds through userinfo, a port, or plain http", () => {
		for (const u of [
			`https://www.youtube.com@evil.example${watch}`,
			`https://www.youtube.com:pw@evil.example${watch}`,
			`https://user@www.youtube.com${watch}`,
			`https://user:pass@www.youtube.com${watch}`,
			`https://evil.example\\@www.youtube.com${watch}`,
			`https://evil.example#@www.youtube.com${watch}`,
			`https://evil.example?@www.youtube.com${watch}`,
			`https://www.youtube.com:8443${watch}`,
			`http://www.youtube.com${watch}`,
			`http://youtu.be/${YT}`,
			`//evil.example/www.youtube.com${watch}`,
		]) {
			expectBookmark(u);
		}
	});

	it("never classifies a non-http scheme, however it is dressed", () => {
		for (const u of [
			`javascript:alert(1)//www.youtube.com${watch}`,
			`javascript://www.youtube.com${watch}%0aalert(1)`,
			`data:text/html,<iframe src="https://www.youtube.com${watch}">`,
			`data://www.youtube.com${watch}`,
			`blob:https://www.youtube.com/${YT}`,
			`file://www.youtube.com${watch}`,
			`ftp://www.youtube.com${watch}`,
			`ws://www.youtube.com${watch}`,
		]) {
			expect(classifyEmbed(u), u).toBeNull();
			expect(classifyUrl(u)?.embedUrl ?? null, u).toBeNull();
		}
	});

	it("ignores an embed URL smuggled inside a path, query or fragment", () => {
		for (const u of [
			`https://evil.example/https://www.youtube.com${watch}`,
			`https://evil.example/?u=https://www.youtube.com${watch}`,
			`https://evil.example/#https://www.youtube.com${watch}`,
			`https://evil.example/redirect?to=youtu.be/${YT}`,
			`https://evil.example/www.youtube.com${watch}`,
		]) {
			expectBookmark(u);
		}
	});
});

describe("embed catalogue invariants", () => {
	it("has a canonical fixture for every provider", () => {
		expect(Object.keys(CANONICAL).sort()).toEqual([...PROVIDER_KINDS].sort());
		expect(PROVIDER_KINDS.sort()).toEqual(
			Object.values(EmbedKind)
				.filter((k) => k !== EmbedKind.Bookmark)
				.sort(),
		);
	});

	it("only ever builds an https embed URL on the provider's own frame origin", () => {
		for (const kind of PROVIDER_KINDS) {
			const match = classifyEmbed(CANONICAL[kind].url);
			const embed = new URL(match?.embedUrl ?? "");
			expect(embed.origin, kind).toBe(EMBED_PROVIDERS[kind].frameOrigin);
			expect(embed.protocol, kind).toBe("https:");
			expect(embed.username + embed.password + embed.port, kind).toBe("");
			expect(new URL(EMBED_PROVIDERS[kind].frameOrigin).origin).toBe(
				EMBED_PROVIDERS[kind].frameOrigin,
			);
		}
	});

	it("is idempotent: a provider's own embed URL classifies back to itself", () => {
		for (const kind of [
			EmbedKind.YouTube,
			EmbedKind.Vimeo,
			EmbedKind.Loom,
			EmbedKind.CodeSandbox,
			EmbedKind.OpenStreetMap,
			EmbedKind.Spotify,
			EmbedKind.Miro,
		] as const) {
			const first = classifyEmbed(CANONICAL[kind].url);
			const again = classifyEmbed(first?.embedUrl ?? "");
			expect(again?.kind, kind).toBe(kind);
			expect(again?.embedUrl, kind).toBe(first?.embedUrl);
		}
	});

	it("grants every frame a sandbox with no navigation, modal or download escape", () => {
		for (const kind of PROVIDER_KINDS) {
			const tokens = EMBED_PROVIDERS[kind].sandbox.split(" ");
			expect(tokens, kind).toContain("allow-scripts");
			for (const forbidden of [
				"allow-top-navigation",
				"allow-top-navigation-by-user-activation",
				"allow-top-navigation-to-custom-protocols",
				"allow-modals",
				"allow-downloads",
				"allow-popups-to-escape-sandbox",
				"allow-pointer-lock",
				"allow-orientation-lock",
				"allow-storage-access-by-user-activation",
			]) {
				expect(tokens, `${kind} ${forbidden}`).not.toContain(forbidden);
			}
			for (const feature of ["camera", "microphone", "geolocation", "display-capture", "*"]) {
				expect(EMBED_PROVIDERS[kind].allow, `${kind} ${feature}`).not.toContain(feature);
			}
		}
	});

	it("holds every provider to click-to-load, and the cookie-setting ones to it permanently", () => {
		const policies = new Set(Object.values(EmbedLoadPolicy));
		for (const kind of PROVIDER_KINDS) {
			expect(policies.has(EMBED_PROVIDERS[kind].loadPolicy), kind).toBe(true);
		}
		expect(EMBED_PROVIDERS[EmbedKind.GoogleMaps].loadPolicy).toBe(EmbedLoadPolicy.ClickToLoadAlways);
		expect(EMBED_PROVIDERS[EmbedKind.OpenStreetMap].loadPolicy).toBe(EmbedLoadPolicy.ClickToLoad);
		expect(EMBED_PROVIDERS[EmbedKind.YouTube].loadPolicy).toBe(EmbedLoadPolicy.ClickToLoad);
	});

	it("gives maps 4:3, video 16:9 and design/code canvases 3:2", () => {
		expect(EMBED_PROVIDERS[EmbedKind.GoogleMaps].aspect).toBe(EmbedAspect.Map);
		expect(EMBED_PROVIDERS[EmbedKind.OpenStreetMap].aspect).toBe(EmbedAspect.Map);
		expect(EMBED_PROVIDERS[EmbedKind.YouTube].aspect).toBe(EmbedAspect.Video);
		expect(EMBED_PROVIDERS[EmbedKind.Figma].aspect).toBe(EmbedAspect.Canvas);
		expect(EMBED_PROVIDERS[EmbedKind.CodeSandbox].aspect).toBe(EmbedAspect.Canvas);
	});
});

describe("faviconUrl", () => {
	it("is the origin's conventional favicon path", () => {
		expect(faviconUrl("https://example.com/deep/page")).toBe("https://example.com/favicon.ico");
		expect(faviconUrl("garbage")).toBeNull();
	});
});
