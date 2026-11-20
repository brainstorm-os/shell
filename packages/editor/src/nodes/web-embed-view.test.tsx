// @vitest-environment jsdom

/**
 * The render-side fence for external embeds: nothing third-party mounts
 * until the user asks, the frame only ever points where a FRESH
 * classification of the persisted URL says, and a URL the allowlist rejects
 * degrades to an inert link.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMBED_PROVIDERS, EmbedKind, type EmbedProviderKind } from "../plugins/embed-providers";
import { WebEmbedView } from "./web-embed-node";

type Harness = { container: HTMLDivElement; root: Root };
let harness: Harness;

beforeEach(() => {
	const container = document.createElement("div");
	document.body.append(container);
	harness = { container, root: createRoot(container) };
});

afterEach(() => {
	act(() => harness.root.unmount());
	harness.container.remove();
});

function render(url: string): void {
	act(() => {
		harness.root.render(<WebEmbedView url={url} />);
	});
}

function load(): void {
	const facade = harness.container.querySelector<HTMLButtonElement>(".notes__embed-facade");
	expect(facade).not.toBeNull();
	act(() => {
		facade?.click();
	});
}

const frame = () => harness.container.querySelector("iframe");

describe("WebEmbedView click-to-load", () => {
	it("mounts no iframe, image or other remote-loading element before the click", () => {
		for (const url of [
			"https://www.youtube.com/watch?v=dQw4w9WgXcQ",
			"https://www.google.com/maps/place/Berlin/@52.52,13.405,12z",
			"https://www.openstreetmap.org/#map=12/52.52/13.405",
			"https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
		]) {
			render(url);
			expect(
				harness.container.querySelector("iframe, img, video, audio, object, embed, link, script"),
				url,
			).toBeNull();
			const facade = harness.container.querySelector<HTMLButtonElement>(".notes__embed-facade");
			expect(facade?.type).toBe("button");
			expect(facade?.getAttribute("aria-label")).toMatch(/^Load /);
		}
	});

	it("names the provider and the host that loading will contact", () => {
		render("https://www.google.com/maps/place/Berlin");
		const text = harness.container.textContent ?? "";
		expect(text).toContain("Google Maps");
		expect(text).toContain("www.google.com");
		expect(harness.container.querySelector(".notes__embed")?.getAttribute("data-aspect")).toBe("map");
	});

	it("loads the rebuilt provider URL with that provider's sandbox on click", () => {
		render("https://youtu.be/dQw4w9WgXcQ?si=tracking-token");
		load();
		const el = frame();
		expect(el?.getAttribute("src")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
		expect(el?.getAttribute("sandbox")).toBe(EMBED_PROVIDERS[EmbedKind.YouTube].sandbox);
		expect(el?.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect(el?.getAttribute("allow")).toBe(EMBED_PROVIDERS[EmbedKind.YouTube].allow);
		expect(el?.hasAttribute("credentialless")).toBe(true);
		expect(el?.getAttribute("title")).toBe("YouTube embed");
		expect(el?.hasAttribute("allowfullscreen")).toBe(false);
	});

	it("leaves a login-gated provider out of the credentialless partition", () => {
		render("https://www.figma.com/design/AbCdEf0123456789abcdef/File");
		load();
		expect(frame()?.hasAttribute("credentialless")).toBe(false);
		expect(new URL(frame()?.getAttribute("src") ?? "").origin).toBe("https://www.figma.com");
	});

	it("points every provider's frame at its catalogue origin", () => {
		const urls: Array<[EmbedProviderKind, string]> = [
			[EmbedKind.Vimeo, "https://vimeo.com/123456789"],
			[EmbedKind.GoogleMaps, "https://maps.google.com/?q=Berlin"],
			[EmbedKind.SoundCloud, "https://soundcloud.com/some-artist/some-track"],
			[EmbedKind.CodePen, "https://codepen.io/some-user/pen/abcXYZ"],
			[EmbedKind.Miro, "https://miro.com/app/board/uXjVO1a2b3c=/"],
		];
		for (const [kind, url] of urls) {
			act(() => harness.root.render(null));
			render(url);
			load();
			expect(new URL(frame()?.getAttribute("src") ?? "").origin, url).toBe(
				EMBED_PROVIDERS[kind].frameOrigin,
			);
			expect(frame()?.getAttribute("sandbox"), url).toBe(EMBED_PROVIDERS[kind].sandbox);
		}
	});
});

describe("WebEmbedView degrade path", () => {
	it("renders an off-allowlist URL as a link, with no facade and no frame", () => {
		for (const url of [
			"https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
			"https://user@www.youtube.com/watch?v=dQw4w9WgXcQ",
			"http://www.youtube.com/watch?v=dQw4w9WgXcQ",
			"https://x.com/someone/status/1234567890123456789",
			"https://gist.github.com/someone/0123456789abcdef0123456789abcdef",
		]) {
			render(url);
			expect(frame(), url).toBeNull();
			expect(harness.container.querySelector(".notes__embed-facade"), url).toBeNull();
			const link = harness.container.querySelector("a");
			expect(link?.getAttribute("rel"), url).toContain("noopener");
			expect(link?.getAttribute("href"), url).toMatch(/^https?:\/\//);
		}
	});

	it("never puts a script or data URL in an href", () => {
		for (const url of [
			"javascript:alert(document.domain)",
			"data:text/html,<script>alert(1)</script>",
			"javascript://www.youtube.com/watch?v=dQw4w9WgXcQ%0aalert(1)",
			"",
		]) {
			render(url);
			expect(frame(), url).toBeNull();
			expect(harness.container.querySelector("a"), url).toBeNull();
			expect(harness.container.querySelector("[href]"), url).toBeNull();
		}
	});
});

describe("WebEmbedView consent is bound to the loaded target", () => {
	it("falls back to the facade when the URL changes under a loaded frame", () => {
		render("https://youtu.be/dQw4w9WgXcQ");
		load();
		expect(frame()?.getAttribute("src")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");

		for (const rewritten of [
			"https://codepen.io/attacker/pen/abcXYZ",
			"https://www.loom.com/share/0281766fa2d04bb788eaf19e65135184",
			"https://youtu.be/AAAAAAAAAAA",
		]) {
			render(rewritten);
			expect(frame(), rewritten).toBeNull();
			expect(harness.container.querySelector(".notes__embed-facade"), rewritten).not.toBeNull();
		}
	});

	it("does not resurrect a frame without a new click when the URL changes back and forth", () => {
		render("https://youtu.be/dQw4w9WgXcQ");
		load();
		render("https://codepen.io/attacker/pen/abcXYZ");
		expect(frame()).toBeNull();
		load();
		expect(new URL(frame()?.getAttribute("src") ?? "").origin).toBe("https://codepen.io");
		render("https://youtu.be/dQw4w9WgXcQ");
		expect(frame()).toBeNull();
	});

	it("keeps the frame across a rerender that leaves the target unchanged", () => {
		render("https://youtu.be/dQw4w9WgXcQ");
		load();
		const before = frame();
		render("https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=other-tracking");
		expect(frame()).toBe(before);
	});
});

describe("WebEmbedView with a non-string synced url", () => {
	it("renders the inert fallback instead of throwing", () => {
		for (const hostile of [
			42,
			null,
			undefined,
			{ href: "https://youtu.be/dQw4w9WgXcQ" },
			["x"],
			true,
		]) {
			expect(() => render(hostile as unknown as string), String(hostile)).not.toThrow();
			expect(frame(), String(hostile)).toBeNull();
			expect(harness.container.querySelector("[href]"), String(hostile)).toBeNull();
			expect(harness.container.querySelector(".notes__embed-facade"), String(hostile)).toBeNull();
		}
	});
});
