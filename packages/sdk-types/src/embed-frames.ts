/**
 * The network-facing half of the external-embed catalogue: which origin each
 * provider's iframe may point at, and whether its player refuses to run
 * without an embedder identity. Lives here — dependency-free — because two
 * sides must agree on it and neither may import the other: the editor builds
 * the frame, the shell main process sees its request.
 */

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

export type EmbedFrame = {
	/** The only origin this provider's iframe may point at. */
	frameOrigin: string;
	/** Path prefix of the player document that must carry the embedder
	 *  `Referer`, or null when the provider does not require one. An app page
	 *  is served from a custom scheme, so Chromium has no referrer to send
	 *  whatever the frame's policy; a provider that hard-requires one gets the
	 *  fixed `EMBEDDER_REFERRER` from the shell instead. Set only with a
	 *  stated reason. */
	embedderReferrerPath: string | null;
};

/** What a referrer-requiring player is told embedded it: the product's public
 *  site. A constant — never derived from the page, the document or the user. */
export const EMBEDDER_REFERRER = "https://getbrainstorm.online/";

export const EMBED_FRAMES: Readonly<Record<EmbedProviderKind, EmbedFrame>> = {
	// YouTube's player requires API clients to identify themselves through the
	// HTTP Referer and fails with "Error 153" without one.
	[EmbedKind.YouTube]: {
		frameOrigin: "https://www.youtube-nocookie.com",
		embedderReferrerPath: "/embed/",
	},
	// Vimeo checks Referer only for domain-restricted videos, against the
	// owner's allowlist — a fixed embedder origin could never satisfy it.
	[EmbedKind.Vimeo]: { frameOrigin: "https://player.vimeo.com", embedderReferrerPath: null },
	[EmbedKind.Loom]: { frameOrigin: "https://www.loom.com", embedderReferrerPath: null },
	[EmbedKind.Figma]: { frameOrigin: "https://www.figma.com", embedderReferrerPath: null },
	[EmbedKind.CodeSandbox]: { frameOrigin: "https://codesandbox.io", embedderReferrerPath: null },
	[EmbedKind.GoogleMaps]: { frameOrigin: "https://www.google.com", embedderReferrerPath: null },
	[EmbedKind.OpenStreetMap]: {
		frameOrigin: "https://www.openstreetmap.org",
		embedderReferrerPath: null,
	},
	[EmbedKind.Spotify]: { frameOrigin: "https://open.spotify.com", embedderReferrerPath: null },
	[EmbedKind.SoundCloud]: { frameOrigin: "https://w.soundcloud.com", embedderReferrerPath: null },
	[EmbedKind.CodePen]: { frameOrigin: "https://codepen.io", embedderReferrerPath: null },
	[EmbedKind.Miro]: { frameOrigin: "https://miro.com", embedderReferrerPath: null },
};
