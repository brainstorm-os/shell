/**
 * URL → embed classification. Pure + dependency-free so it unit-tests
 * exhaustively and runs the same in the paste path, the slash path and
 * the render path.
 *
 * Only an allowlist of providers becomes an `<iframe>` embed; anything
 * else is a bookmark card. A provider is one `MATCHERS` entry plus one
 * `EMBED_PROVIDERS` row — never a new node type.
 *
 * Security invariants (attacked in embed-providers.test.ts):
 *   - hosts match EXACTLY against a per-provider set — no suffix or
 *     substring test, so `youtube.com.evil.example` / `evilyoutube.com`
 *     never classify;
 *   - an embeddable URL is https, default port, no userinfo;
 *   - the embed URL is REBUILT from validated tokens (ids matched by a
 *     strict charset, numbers re-serialised) on the provider's fixed
 *     embed origin — user input is never interpolated verbatim;
 *   - the rebuilt URL's origin must equal the catalogue row's
 *     `frameOrigin`, which is exactly what the app-page CSP `frame-src`
 *     grants (embed-csp.test.ts pins the two together).
 */

import type { EditorI18nKey } from "../i18n";

export enum EmbedKind {
	YouTube = "youtube",
	Vimeo = "vimeo",
	Loom = "loom",
	Figma = "figma",
	CodeSandbox = "codesandbox",
	GoogleMaps = "google-maps",
	OpenStreetMap = "openstreetmap",
	Spotify = "spotify",
	SoundCloud = "soundcloud",
	CodePen = "codepen",
	Miro = "miro",
	/** Not embeddable — render a link/bookmark card instead. */
	Bookmark = "bookmark",
}

export type EmbedProviderKind = Exclude<EmbedKind, EmbedKind.Bookmark>;

/** The frame's shape, applied as `data-aspect` (sized in editor-theme.css). */
export enum EmbedAspect {
	Video = "video",
	Map = "map",
	Canvas = "canvas",
	Audio = "audio",
	AudioList = "audio-list",
}

/** Nothing loads on render under either policy. `ClickToLoadAlways` marks a
 *  provider with no cookie-free endpoint: a future per-vault "auto-load
 *  embeds" setting (doc 38, OQ-164) may relax `ClickToLoad`, never this. */
export enum EmbedLoadPolicy {
	ClickToLoad = "click-to-load",
	ClickToLoadAlways = "click-to-load-always",
}

export type EmbedProvider = {
	/** The only origin this provider's iframe may point at. */
	frameOrigin: string;
	aspect: EmbedAspect;
	loadPolicy: EmbedLoadPolicy;
	/** `sandbox` tokens — the minimum the provider's player needs. */
	sandbox: string;
	/** Permissions-Policy `allow` list. */
	allow: string;
	/** Load in an ephemeral, cookie-less storage partition (`<iframe
	 *  credentialless>`). Off only where the content is routinely
	 *  login-gated and a partitioned frame would make it unusable. */
	credentialless: boolean;
	labelKey: EditorI18nKey;
};

const SANDBOX_BASE = "allow-scripts allow-same-origin allow-popups";
const SANDBOX_VIDEO = `${SANDBOX_BASE} allow-presentation`;
// Sandbox flags propagate into the nested preview frame these two host, and
// a preview with a <form> is dead without `allow-forms`.
const SANDBOX_PLAYGROUND = `${SANDBOX_BASE} allow-forms`;

export const EMBED_PROVIDERS: Readonly<Record<EmbedProviderKind, EmbedProvider>> = {
	[EmbedKind.YouTube]: {
		frameOrigin: "https://www.youtube-nocookie.com",
		aspect: EmbedAspect.Video,
		loadPolicy: EmbedLoadPolicy.ClickToLoad,
		sandbox: SANDBOX_VIDEO,
		allow: "fullscreen; picture-in-picture; encrypted-media",
		credentialless: true,
		labelKey: "editor.embed.provider.youtube",
	},
	[EmbedKind.Vimeo]: {
		frameOrigin: "https://player.vimeo.com",
		aspect: EmbedAspect.Video,
		loadPolicy: EmbedLoadPolicy.ClickToLoad,
		sandbox: SANDBOX_VIDEO,
		allow: "fullscreen; picture-in-picture",
		credentialless: true,
		labelKey: "editor.embed.provider.vimeo",
	},
	[EmbedKind.Loom]: {
		frameOrigin: "https://www.loom.com",
		aspect: EmbedAspect.Video,
		loadPolicy: EmbedLoadPolicy.ClickToLoadAlways,
		sandbox: SANDBOX_VIDEO,
		allow: "fullscreen; picture-in-picture",
		credentialless: false,
		labelKey: "editor.embed.provider.loom",
	},
	[EmbedKind.Figma]: {
		frameOrigin: "https://www.figma.com",
		aspect: EmbedAspect.Canvas,
		loadPolicy: EmbedLoadPolicy.ClickToLoadAlways,
		sandbox: SANDBOX_BASE,
		allow: "fullscreen",
		credentialless: false,
		labelKey: "editor.embed.provider.figma",
	},
	[EmbedKind.CodeSandbox]: {
		frameOrigin: "https://codesandbox.io",
		aspect: EmbedAspect.Canvas,
		loadPolicy: EmbedLoadPolicy.ClickToLoad,
		sandbox: SANDBOX_PLAYGROUND,
		allow: "fullscreen; clipboard-write",
		credentialless: true,
		labelKey: "editor.embed.provider.codesandbox",
	},
	[EmbedKind.GoogleMaps]: {
		frameOrigin: "https://www.google.com",
		aspect: EmbedAspect.Map,
		loadPolicy: EmbedLoadPolicy.ClickToLoadAlways,
		sandbox: SANDBOX_BASE,
		allow: "fullscreen",
		credentialless: true,
		labelKey: "editor.embed.provider.googleMaps",
	},
	[EmbedKind.OpenStreetMap]: {
		frameOrigin: "https://www.openstreetmap.org",
		aspect: EmbedAspect.Map,
		loadPolicy: EmbedLoadPolicy.ClickToLoad,
		sandbox: SANDBOX_BASE,
		allow: "fullscreen",
		credentialless: true,
		labelKey: "editor.embed.provider.openStreetMap",
	},
	[EmbedKind.Spotify]: {
		frameOrigin: "https://open.spotify.com",
		aspect: EmbedAspect.Audio,
		loadPolicy: EmbedLoadPolicy.ClickToLoadAlways,
		sandbox: SANDBOX_BASE,
		allow: "encrypted-media",
		credentialless: true,
		labelKey: "editor.embed.provider.spotify",
	},
	[EmbedKind.SoundCloud]: {
		frameOrigin: "https://w.soundcloud.com",
		aspect: EmbedAspect.Audio,
		loadPolicy: EmbedLoadPolicy.ClickToLoadAlways,
		sandbox: SANDBOX_BASE,
		allow: "",
		credentialless: true,
		labelKey: "editor.embed.provider.soundCloud",
	},
	[EmbedKind.CodePen]: {
		frameOrigin: "https://codepen.io",
		aspect: EmbedAspect.Canvas,
		loadPolicy: EmbedLoadPolicy.ClickToLoad,
		sandbox: SANDBOX_PLAYGROUND,
		allow: "fullscreen; clipboard-write",
		credentialless: true,
		labelKey: "editor.embed.provider.codePen",
	},
	[EmbedKind.Miro]: {
		frameOrigin: "https://miro.com",
		aspect: EmbedAspect.Canvas,
		loadPolicy: EmbedLoadPolicy.ClickToLoadAlways,
		sandbox: SANDBOX_BASE,
		allow: "fullscreen",
		credentialless: false,
		labelKey: "editor.embed.provider.miro",
	},
};

export type EmbedMatch = {
	kind: EmbedProviderKind;
	/** The `<iframe>` src — rebuilt, on the provider's `frameOrigin`. */
	embedUrl: string;
	aspect: EmbedAspect;
	host: string;
};

export type UrlClassification =
	| EmbedMatch
	| { kind: EmbedKind.Bookmark; embedUrl: null; aspect: null; host: string };

/** Parse a string into a URL, tolerating a missing scheme (`foo.com` →
 *  `https://foo.com`). Returns null when it still isn't a valid http(s)
 *  URL. */
export function parseHttpUrl(raw: string): URL | null {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return null;
	const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	if (!url.hostname.includes(".")) return null;
	return url;
}

/** The href a link/bookmark card may carry: the parsed http(s) URL, or null.
 *  A persisted `url` is attacker-controlled (CRDT sync, paste), so it never
 *  reaches an `href` unparsed — `javascript:` / `data:` fall out here. */
export function safeExternalHref(raw: string): string | null {
	return parseHttpUrl(raw)?.href ?? null;
}

/** True for a string that is *only* a single URL (the paste-to-bookmark
 *  trigger — pasting a sentence that contains a link must not convert). */
export function isLoneUrl(raw: string): boolean {
	const trimmed = raw.trim();
	if (/\s/.test(trimmed)) return false;
	return parseHttpUrl(trimmed) !== null;
}

type ProviderMatch = { kind: EmbedProviderKind; embedUrl: string; aspect?: EmbedAspect };
type Matcher = (url: URL, segments: readonly string[]) => ProviderMatch | null;

function hosts(...names: string[]): ReadonlySet<string> {
	return new Set(names);
}

function token(value: string | null | undefined, pattern: RegExp): string | null {
	return typeof value === "string" && pattern.test(value) ? value : null;
}

const YOUTUBE_HOSTS = hosts("youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com");
const YOUTUBE_EMBED_HOSTS = hosts("www.youtube-nocookie.com", "youtube-nocookie.com");
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PATH_KINDS = hosts("embed", "shorts", "live");

function matchYouTube(url: URL, segments: readonly string[]): ProviderMatch | null {
	let id: string | null = null;
	if (url.hostname === "youtu.be") {
		if (segments.length === 1) id = token(segments[0], YOUTUBE_ID);
	} else if (YOUTUBE_HOSTS.has(url.hostname)) {
		if (url.pathname === "/watch") id = token(url.searchParams.get("v"), YOUTUBE_ID);
		else if (segments.length === 2 && YOUTUBE_PATH_KINDS.has(segments[0] ?? "")) {
			id = token(segments[1], YOUTUBE_ID);
		}
	} else if (YOUTUBE_EMBED_HOSTS.has(url.hostname)) {
		if (segments.length === 2 && segments[0] === "embed") id = token(segments[1], YOUTUBE_ID);
	}
	if (!id) return null;
	const embed = new URL(`https://www.youtube-nocookie.com/embed/${id}`);
	const start = /^(\d{1,6})s?$/.exec(
		url.searchParams.get("t") ?? url.searchParams.get("start") ?? "",
	);
	if (start?.[1]) embed.searchParams.set("start", String(Number(start[1])));
	return { kind: EmbedKind.YouTube, embedUrl: embed.href };
}

const VIMEO_HOSTS = hosts("vimeo.com", "www.vimeo.com");
const VIMEO_ID = /^\d{1,12}$/;
const VIMEO_HASH = /^[0-9a-f]{6,16}$/;

function matchVimeo(url: URL, segments: readonly string[]): ProviderMatch | null {
	let id: string | null = null;
	let hash: string | null = null;
	if (VIMEO_HOSTS.has(url.hostname)) {
		if (segments.length < 1 || segments.length > 2) return null;
		id = token(segments[0], VIMEO_ID);
		if (segments.length === 2) {
			hash = token(segments[1], VIMEO_HASH);
			if (!hash) return null;
		}
	} else if (url.hostname === "player.vimeo.com") {
		if (segments.length === 2 && segments[0] === "video") id = token(segments[1], VIMEO_ID);
		hash = token(url.searchParams.get("h"), VIMEO_HASH);
	}
	if (!id) return null;
	const embed = new URL(`https://player.vimeo.com/video/${id}`);
	if (hash) embed.searchParams.set("h", hash);
	embed.searchParams.set("dnt", "1");
	return { kind: EmbedKind.Vimeo, embedUrl: embed.href };
}

const LOOM_HOSTS = hosts("loom.com", "www.loom.com");
const LOOM_ID = /^[A-Za-z0-9]{6,64}$/;
const LOOM_PATH_KINDS = hosts("share", "embed");

function matchLoom(url: URL, segments: readonly string[]): ProviderMatch | null {
	if (!LOOM_HOSTS.has(url.hostname)) return null;
	if (segments.length !== 2 || !LOOM_PATH_KINDS.has(segments[0] ?? "")) return null;
	const id = token(segments[1], LOOM_ID);
	return id ? { kind: EmbedKind.Loom, embedUrl: `https://www.loom.com/embed/${id}` } : null;
}

const FIGMA_HOSTS = hosts("figma.com", "www.figma.com");
const FIGMA_PATH_KINDS = hosts("file", "design", "proto", "board", "slides");
const FIGMA_KEY = /^[A-Za-z0-9]{6,64}$/;
const FIGMA_SLUG = /^[A-Za-z0-9._~-]{1,200}$/;
const FIGMA_NODE_ID = /^\d{1,10}[-:]\d{1,10}$/;

function matchFigma(url: URL, segments: readonly string[]): ProviderMatch | null {
	if (!FIGMA_HOSTS.has(url.hostname)) return null;
	if (segments.length < 2 || segments.length > 3) return null;
	const pathKind = segments[0] ?? "";
	if (!FIGMA_PATH_KINDS.has(pathKind)) return null;
	const key = token(segments[1], FIGMA_KEY);
	if (!key) return null;
	const slug = token(segments[2], FIGMA_SLUG);
	const file = new URL(`https://www.figma.com/${pathKind}/${key}${slug ? `/${slug}` : ""}`);
	const nodeId = token(url.searchParams.get("node-id"), FIGMA_NODE_ID);
	if (nodeId) file.searchParams.set("node-id", nodeId);
	const embed = new URL("https://www.figma.com/embed");
	embed.searchParams.set("embed_host", "brainstorm");
	embed.searchParams.set("url", file.href);
	return { kind: EmbedKind.Figma, embedUrl: embed.href };
}

const CODESANDBOX_HOSTS = hosts("codesandbox.io", "www.codesandbox.io");
const CODESANDBOX_ID = /^[A-Za-z0-9-]{1,80}$/;
const CODESANDBOX_PATH_KINDS = hosts("s", "embed");

function matchCodeSandbox(url: URL, segments: readonly string[]): ProviderMatch | null {
	if (!CODESANDBOX_HOSTS.has(url.hostname)) return null;
	if (segments.length !== 2 || !CODESANDBOX_PATH_KINDS.has(segments[0] ?? "")) return null;
	const id = token(segments[1], CODESANDBOX_ID);
	return id ? { kind: EmbedKind.CodeSandbox, embedUrl: `https://codesandbox.io/embed/${id}` } : null;
}

const DECIMAL = /^-?\d{1,3}(?:\.\d{1,12})?$/;

function coordinate(raw: string | null | undefined, limit: number): number | null {
	if (typeof raw !== "string" || !DECIMAL.test(raw)) return null;
	const n = Number(raw);
	return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

function fixed(n: number): string {
	return String(Number(n.toFixed(6)));
}

const MAX_MAP_QUERY = 200;

/** A free-text map query is the one place user text reaches an embed URL.
 *  It is decoded, stripped of control characters, length-capped, and only
 *  ever re-encoded by `URLSearchParams` as a single `q` value. */
function mapQuery(raw: string | null | undefined): string | null {
	if (typeof raw !== "string") return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw.replace(/\+/g, " "));
	} catch {
		return null;
	}
	const clean = [...decoded]
		.filter((ch) => {
			const code = ch.codePointAt(0) ?? 0;
			return code >= 0x20 && code !== 0x7f;
		})
		.join("")
		.trim();
	return clean.length > 0 && clean.length <= MAX_MAP_QUERY ? clean : null;
}

const GOOGLE_MAPS_HOSTS = hosts("google.com", "www.google.com", "maps.google.com");
const GOOGLE_MAPS_VIEWPORT = /^@(-?[\d.]+),(-?[\d.]+)(?:,(\d{1,2})(?:\.\d+)?z)?/;
const DEFAULT_MAP_ZOOM = 15;
const MAX_GOOGLE_ZOOM = 21;

function matchGoogleMaps(url: URL, segments: readonly string[]): ProviderMatch | null {
	if (!GOOGLE_MAPS_HOSTS.has(url.hostname)) return null;
	const rest =
		segments[0] === "maps" ? segments.slice(1) : url.hostname === "maps.google.com" ? segments : null;
	if (!rest) return null;

	let query: string | null = null;
	if (rest.length === 0) query = mapQuery(url.searchParams.get("q"));
	else if ((rest[0] === "place" || rest[0] === "search") && rest[1]) query = mapQuery(rest[1]);
	else if (!rest[0]?.startsWith("@")) return null;

	let zoom = DEFAULT_MAP_ZOOM;
	let centre: string | null = null;
	const viewport = rest.find((s) => s.startsWith("@"));
	const m = viewport ? GOOGLE_MAPS_VIEWPORT.exec(viewport) : null;
	if (m) {
		const lat = coordinate(m[1], 90);
		const lng = coordinate(m[2], 180);
		if (lat !== null && lng !== null) centre = `${fixed(lat)},${fixed(lng)}`;
		const z = m[3] ? Number(m[3]) : Number.NaN;
		if (Number.isInteger(z) && z >= 0 && z <= MAX_GOOGLE_ZOOM) zoom = z;
	}

	const q = query ?? centre;
	if (!q) return null;
	const embed = new URL("https://www.google.com/maps");
	embed.searchParams.set("q", q);
	embed.searchParams.set("z", String(zoom));
	embed.searchParams.set("output", "embed");
	return { kind: EmbedKind.GoogleMaps, embedUrl: embed.href };
}

const OSM_HOSTS = hosts("openstreetmap.org", "www.openstreetmap.org");
const OSM_MAP_HASH = /^#map=(\d{1,2})\/(-?[\d.]+)\/(-?[\d.]+)/;
const MAX_OSM_ZOOM = 19;
const MERCATOR_MAX_LAT = 85.0511;

function clamp(n: number, limit: number): number {
	return Math.max(-limit, Math.min(limit, n));
}

/** OSM's embed endpoint takes a bounding box, not centre+zoom: derive a box
 *  about three tiles wide at the requested zoom, 4:3 like the frame. */
function osmBbox(lat: number, lon: number, zoom: number): string {
	const halfLon = (1.5 * 360) / 2 ** zoom;
	const halfLat = halfLon * 0.75 * Math.cos((lat * Math.PI) / 180);
	return [
		clamp(lon - halfLon, 180),
		clamp(lat - halfLat, MERCATOR_MAX_LAT),
		clamp(lon + halfLon, 180),
		clamp(lat + halfLat, MERCATOR_MAX_LAT),
	]
		.map(fixed)
		.join(",");
}

function matchOpenStreetMap(url: URL, segments: readonly string[]): ProviderMatch | null {
	if (!OSM_HOSTS.has(url.hostname)) return null;
	const embed = new URL("https://www.openstreetmap.org/export/embed.html");

	if (segments.length === 2 && segments[0] === "export" && segments[1] === "embed.html") {
		const parts = (url.searchParams.get("bbox") ?? "").split(",");
		if (parts.length !== 4) return null;
		const box = [
			coordinate(parts[0], 180),
			coordinate(parts[1], 90),
			coordinate(parts[2], 180),
			coordinate(parts[3], 90),
		];
		if (box.some((n) => n === null)) return null;
		embed.searchParams.set("bbox", box.map((n) => fixed(n ?? 0)).join(","));
		const marker = (url.searchParams.get("marker") ?? "").split(",");
		const lat = coordinate(marker[0], 90);
		const lon = coordinate(marker[1], 180);
		if (marker.length === 2 && lat !== null && lon !== null) {
			embed.searchParams.set("marker", `${fixed(lat)},${fixed(lon)}`);
		}
	} else {
		if (segments.length > 0) return null;
		const hash = OSM_MAP_HASH.exec(url.hash);
		const markerLat = coordinate(url.searchParams.get("mlat"), 90);
		const markerLon = coordinate(url.searchParams.get("mlon"), 180);
		const hasMarker = markerLat !== null && markerLon !== null;
		const lat = hash ? coordinate(hash[2], 90) : markerLat;
		const lon = hash ? coordinate(hash[3], 180) : markerLon;
		if (lat === null || lon === null) return null;
		const z = Number(hash ? hash[1] : (url.searchParams.get("zoom") ?? DEFAULT_MAP_ZOOM));
		const zoom = Number.isInteger(z) && z >= 0 && z <= MAX_OSM_ZOOM ? z : DEFAULT_MAP_ZOOM;
		embed.searchParams.set("bbox", osmBbox(lat, lon, zoom));
		if (hasMarker) embed.searchParams.set("marker", `${fixed(markerLat)},${fixed(markerLon)}`);
	}
	embed.searchParams.set("layer", "mapnik");
	return { kind: EmbedKind.OpenStreetMap, embedUrl: embed.href };
}

const SPOTIFY_SINGLE = hosts("track", "episode");
const SPOTIFY_LIST = hosts("album", "playlist", "show", "artist");
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const SPOTIFY_LOCALE_PREFIX = /^intl-[a-z]{2}$/;

function matchSpotify(url: URL, segments: readonly string[]): ProviderMatch | null {
	if (url.hostname !== "open.spotify.com") return null;
	const first = segments[0] ?? "";
	const rest = first === "embed" || SPOTIFY_LOCALE_PREFIX.test(first) ? segments.slice(1) : segments;
	if (rest.length !== 2) return null;
	const type = rest[0] ?? "";
	const single = SPOTIFY_SINGLE.has(type);
	if (!single && !SPOTIFY_LIST.has(type)) return null;
	const id = token(rest[1], SPOTIFY_ID);
	if (!id) return null;
	return {
		kind: EmbedKind.Spotify,
		embedUrl: `https://open.spotify.com/embed/${type}/${id}`,
		aspect: single ? EmbedAspect.Audio : EmbedAspect.AudioList,
	};
}

const SOUNDCLOUD_HOSTS = hosts("soundcloud.com", "www.soundcloud.com", "m.soundcloud.com");
const SOUNDCLOUD_SLUG = /^[A-Za-z0-9_-]{1,100}$/;
const SOUNDCLOUD_RESERVED = hosts(
	"charts",
	"discover",
	"feed",
	"jobs",
	"legal",
	"messages",
	"notifications",
	"pages",
	"people",
	"popular",
	"search",
	"settings",
	"stations",
	"stream",
	"tags",
	"terms-of-use",
	"upload",
	"you",
);

function matchSoundCloud(url: URL, segments: readonly string[]): ProviderMatch | null {
	if (!SOUNDCLOUD_HOSTS.has(url.hostname)) return null;
	const isSet = segments.length === 3 && segments[1] === "sets";
	if (segments.length !== 2 && !isSet) return null;
	const user = token(segments[0], SOUNDCLOUD_SLUG);
	const slug = token(segments[isSet ? 2 : 1], SOUNDCLOUD_SLUG);
	if (!user || !slug || SOUNDCLOUD_RESERVED.has(user) || (!isSet && slug === "sets")) return null;
	const embed = new URL("https://w.soundcloud.com/player/");
	embed.searchParams.set("url", `https://soundcloud.com/${user}/${isSet ? "sets/" : ""}${slug}`);
	embed.searchParams.set("auto_play", "false");
	embed.searchParams.set("hide_related", "true");
	embed.searchParams.set("show_comments", "false");
	embed.searchParams.set("visual", "false");
	return {
		kind: EmbedKind.SoundCloud,
		embedUrl: embed.href,
		aspect: isSet ? EmbedAspect.AudioList : EmbedAspect.Audio,
	};
}

const CODEPEN_HOSTS = hosts("codepen.io", "www.codepen.io");
const CODEPEN_USER = /^[A-Za-z0-9_-]{1,60}$/;
const CODEPEN_ID = /^[A-Za-z0-9]{4,16}$/;
const CODEPEN_PATH_KINDS = hosts("pen", "full", "details", "embed");

function matchCodePen(url: URL, segments: readonly string[]): ProviderMatch | null {
	if (!CODEPEN_HOSTS.has(url.hostname)) return null;
	if (segments.length !== 3 || !CODEPEN_PATH_KINDS.has(segments[1] ?? "")) return null;
	const user = token(segments[0], CODEPEN_USER);
	const id = token(segments[2], CODEPEN_ID);
	if (!user || !id) return null;
	return {
		kind: EmbedKind.CodePen,
		embedUrl: `https://codepen.io/${user}/embed/${id}?default-tab=result`,
	};
}

const MIRO_HOSTS = hosts("miro.com", "www.miro.com");
const MIRO_BOARD_ID = /^[A-Za-z0-9_-]{6,40}=?$/;
const MIRO_PATH_KINDS = hosts("board", "live-embed");

function matchMiro(url: URL, segments: readonly string[]): ProviderMatch | null {
	if (!MIRO_HOSTS.has(url.hostname)) return null;
	if (segments.length !== 3 || segments[0] !== "app") return null;
	if (!MIRO_PATH_KINDS.has(segments[1] ?? "")) return null;
	const id = token(segments[2], MIRO_BOARD_ID);
	if (!id) return null;
	return {
		kind: EmbedKind.Miro,
		embedUrl: `https://miro.com/app/live-embed/${id}/?embedMode=view_only_without_ui`,
	};
}

// X/Twitter and GitHub Gist are deliberately absent: both embed through a
// script injected into the host page, which never runs in an app renderer,
// and doc 38 holds X to link-preview only. They classify as bookmark cards.
const MATCHERS: readonly Matcher[] = [
	matchYouTube,
	matchVimeo,
	matchLoom,
	matchFigma,
	matchCodeSandbox,
	matchGoogleMaps,
	matchOpenStreetMap,
	matchSpotify,
	matchSoundCloud,
	matchCodePen,
	matchMiro,
];

function isEmbeddableOrigin(url: URL): boolean {
	return url.protocol === "https:" && url.port === "" && url.username === "" && url.password === "";
}

function matchProvider(url: URL): ProviderMatch | null {
	if (!isEmbeddableOrigin(url)) return null;
	const segments = url.pathname.split("/").filter(Boolean);
	for (const matcher of MATCHERS) {
		const match = matcher(url, segments);
		if (!match) continue;
		let origin: string;
		try {
			origin = new URL(match.embedUrl).origin;
		} catch {
			return null;
		}
		return origin === EMBED_PROVIDERS[match.kind].frameOrigin ? match : null;
	}
	return null;
}

export function classifyUrl(raw: string): UrlClassification | null {
	const url = parseHttpUrl(raw);
	if (!url) return null;
	const host = url.hostname.replace(/^www\./, "");
	const match = matchProvider(url);
	if (!match) return { kind: EmbedKind.Bookmark, embedUrl: null, aspect: null, host };
	return {
		kind: match.kind,
		embedUrl: match.embedUrl,
		aspect: match.aspect ?? EMBED_PROVIDERS[match.kind].aspect,
		host,
	};
}

/** The classification when — and only when — the URL is an allowlisted
 *  provider. The single embed-vs-bookmark decision every caller shares. */
export function classifyEmbed(raw: string): EmbedMatch | null {
	const c = classifyUrl(raw);
	return c && c.kind !== EmbedKind.Bookmark ? c : null;
}

/** Best-effort favicon for a bookmark card. Uses the origin's
 *  conventional path; the renderer falls back to a generic glyph
 *  `onerror`, so a 404 is harmless and no metadata service is needed. */
export function faviconUrl(raw: string): string | null {
	const url = parseHttpUrl(raw);
	return url ? `${url.origin}/favicon.ico` : null;
}
