import { describe, expect, it } from "vitest";
import {
	type SiteBodyState,
	type SiteLinkResolvers,
	type SiteNode,
	assembleSite,
	collectAssetIds,
} from "./assemble-site";
import { isSafeArchivePath, zipStore } from "./zip";

const decode = (data: Uint8Array) => new TextDecoder().decode(data);
const LABELS = { pages: "Pages", untitled: "Untitled" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const text = (value: string): SiteNode => ({ type: "text", text: value });
const body = (...children: SiteNode[]): SiteBodyState => ({ root: { type: "root", children } });
const image = (assetId: string): SiteNode => ({
	type: "image-block",
	src: `brainstorm://asset/${assetId}`,
});
const mention = (entityId: string, label: string): SiteNode => ({
	type: "mention",
	entityId,
	label,
});

/** A stand-in body renderer that resolves references through `links` only —
 *  the same contract the real serializer is held to. */
function renderBody(state: SiteBodyState, links: SiteLinkResolvers): string {
	const render = (node: SiteNode): string => {
		if (node.type === "mention") {
			const href = links.resolveEntityHref(String(node.entityId));
			return href ? `<a href="${href}">${String(node.label)}</a>` : "[unpublished]";
		}
		if (node.type === "image-block") {
			const src = links.resolveAssetSrc(String(node.src).slice("brainstorm://asset/".length));
			return src ? `<img src="${src}" />` : "";
		}
		if (node.type === "text") return String(node.text);
		return ((node.children as SiteNode[] | undefined) ?? []).map(render).join("");
	};
	return state.root ? render(state.root) : "";
}

function build(
	pages: Array<{ id: string; title: string; state: SiteBodyState | null }>,
	extra: Partial<Parameters<typeof assembleSite>[0]> = {},
): Map<string, string> {
	const { files } = assembleSite({
		pages,
		homeId: pages[0]?.id ?? "",
		siteTitle: pages[0]?.title ?? "",
		tokens: { "--color-text-primary": "#111111" },
		labels: LABELS,
		renderBody,
		...extra,
	});
	return new Map(files.map((file) => [file.path, decode(file.bytes)]));
}

describe("assembleSite", () => {
	it("writes index.html, one page per member, and the stylesheet", () => {
		const site = build([
			{ id: "home", title: "Handbook", state: body(mention("p1", "Onboarding")) },
			{ id: "p1", title: "Onboarding", state: body(text("Welcome aboard")) },
		]);
		expect([...site.keys()]).toEqual(["index.html", "onboarding.html", "styles.css"]);
		const home = site.get("index.html") ?? "";
		expect(home.startsWith("<!doctype html>")).toBe(true);
		expect(home).toContain("<title>Handbook</title>");
		expect(home).toContain('<link rel="stylesheet" href="styles.css" />');
		expect(home).toContain("<h1>Handbook</h1>");
		expect(home).toContain('<a href="onboarding.html">Onboarding</a>');
		expect(home).toContain('<nav class="site-pages" aria-label="Pages">');
		const page = site.get("onboarding.html") ?? "";
		expect(page).toContain("<title>Onboarding · Handbook</title>");
		expect(page).toContain('<a class="site-title" href="index.html">Handbook</a>');
		expect(page).not.toContain("site-pages");
		expect(site.get("styles.css")).toContain("--color-text-primary: #111111;");
	});

	it("does not repeat the heading when the body opens with its own title", () => {
		const site = build([
			{
				id: "home",
				title: "Handbook",
				state: body({ type: "title", children: [text("Handbook")] }),
			},
		]);
		expect(site.get("index.html")).not.toContain("<h1>");
	});

	it("names an untitled page with the given label and still writes a body-less one", () => {
		const site = build([
			{ id: "home", title: "Home", state: null },
			{ id: "p", title: "   ", state: null },
		]);
		expect(site.get("page.html")).toBeUndefined();
		expect(site.get("untitled.html")).toContain("<h1>Untitled</h1>");
	});

	it("refuses a home page that is not one of the pages", () => {
		expect(() => build([{ id: "a", title: "A", state: null }], { homeId: "elsewhere" })).toThrow(
			/home page is not in the site/,
		);
	});

	it("publishes a repeated id once", () => {
		const site = build([
			{ id: "home", title: "Home", state: null },
			{ id: "p", title: "Page", state: null },
			{ id: "p", title: "Page again", state: null },
		]);
		expect([...site.keys()]).toEqual(["index.html", "page.html", "styles.css"]);
	});

	it("references nothing outside the site and forbids script, plugins and frames", () => {
		const home = build([{ id: "home", title: "Home", state: null }]).get("index.html") ?? "";
		expect(home).toContain(
			"script-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
		);
		expect(home).not.toMatch(/<script|<iframe|<link rel="(?!stylesheet)/);
		expect(home.match(/https?:\/\//g)).toBeNull();
	});
});

describe("assembleSite — what leaves the vault", () => {
	const SECRET_ID = "0d9f7c1e-secret-entity";
	const SECRET_TITLE = "Acquisition talks";

	it("never emits the id or the title of an entity outside the set", () => {
		const site = build([
			{
				id: "home",
				title: "Public",
				state: body(text("See "), mention(SECRET_ID, SECRET_TITLE), text(".")),
			},
		]);
		for (const [path, content] of site) {
			expect(path).not.toContain(SECRET_ID);
			expect(content).not.toContain(SECRET_ID);
			expect(content).not.toContain(SECRET_TITLE);
		}
		expect(site.get("index.html")).toContain("See [unpublished].");
	});

	it("resolves a link only to a page in the set", () => {
		let resolvers: SiteLinkResolvers | null = null;
		build(
			[
				{ id: "home", title: "Home", state: body(text("x")) },
				{ id: "in", title: "Inside", state: null },
			],
			{
				renderBody: (_state, links) => {
					resolvers = links;
					return "";
				},
			},
		);
		const links = resolvers as SiteLinkResolvers | null;
		expect(links?.resolveEntityHref("in")).toBe("inside.html");
		expect(links?.resolveEntityHref("home")).toBe("index.html");
		expect(links?.resolveEntityHref(SECRET_ID)).toBeNull();
		expect(links?.resolveEntityHref("__proto__")).toBeNull();
		expect(links?.resolveEntityHref("constructor")).toBeNull();
	});

	it("never puts an entity id in a file name", () => {
		const site = build([
			{ id: "home-id-123", title: "Home", state: null },
			{ id: "page-id-456", title: "", state: null },
		]);
		for (const path of site.keys()) expect(path).not.toMatch(/id-\d+/);
	});

	it("copies an asset only when a published page shows it", () => {
		const assets = new Map([
			["shown", { bytes: PNG, mime: "image/png" }],
			["unused", { bytes: new Uint8Array([1, 2, 3]), mime: "image/png" }],
		]);
		const { files } = assembleSite({
			pages: [{ id: "home", title: "Home", state: body(image("shown"), image("shown")) }],
			homeId: "home",
			siteTitle: "Home",
			tokens: {},
			labels: LABELS,
			assets,
			renderBody,
		});
		const paths = files.map((file) => file.path);
		expect(paths).toEqual(["index.html", "styles.css", "assets/1.png"]);
		expect(files.find((file) => file.path === "assets/1.png")?.bytes).toEqual(PNG);
		const home = decode(files[0]?.bytes ?? new Uint8Array());
		expect(home.match(/assets\/1\.png/g)).toHaveLength(2);
		expect(home).not.toContain("shown");
	});

	it("drops an image whose bytes were not supplied, or that is not a raster image", () => {
		const assets = new Map([
			["svg", { bytes: PNG, mime: "image/svg+xml" }],
			["html", { bytes: PNG, mime: "text/html" }],
			["bin", { bytes: PNG, mime: "application/octet-stream" }],
			["jpeg", { bytes: PNG, mime: " IMAGE/JPEG " }],
		]);
		const site = build(
			[
				{
					id: "home",
					title: "Home",
					state: body(image("svg"), image("html"), image("bin"), image("missing"), image("jpeg")),
				},
			],
			{ assets },
		);
		expect([...site.keys()]).toEqual(["index.html", "styles.css", "assets/1.jpg"]);
		expect(site.get("index.html")?.match(/<img/g)).toHaveLength(1);
	});

	it("escapes titles everywhere they are written", () => {
		const hostile = '</title><script>alert("x")</script><img src=x onerror=1>';
		const site = build([
			{ id: "home", title: hostile, state: null },
			{ id: "p", title: `${hostile} two`, state: null },
		]);
		for (const [path, content] of site) {
			if (!path.endsWith(".html")) continue;
			expect(content).not.toContain("<script>");
			expect(content).not.toContain("<img src=x");
			expect(content).not.toContain("</title><");
			expect(content).toContain("&lt;script&gt;");
		}
		expect(
			build([{ id: "home", title: "Home", state: null }], {
				labels: { pages: '"><b>', untitled: "U" },
			}).get("index.html"),
		).not.toContain("<b>");
	});

	it("plans only paths the archive writer accepts, whatever the titles say", () => {
		const titles = ["../../etc/passwd", "/root", "C:\\x", "a/b", "..", "index", "INDEX", "con", ""];
		const { files } = assembleSite({
			pages: [
				{ id: "home", title: "Home", state: null },
				...titles.map((title, index) => ({ id: `p${index}`, title, state: null })),
			],
			homeId: "home",
			siteTitle: "Home",
			tokens: {},
			labels: LABELS,
			renderBody,
		});
		expect(files).toHaveLength(titles.length + 2);
		for (const file of files) {
			expect(isSafeArchivePath(file.path)).toBe(true);
			expect(file.path).toMatch(/^[a-z0-9-]+\.(html|css)$/);
		}
		expect(() => zipStore(files)).not.toThrow();
	});
});

describe("collectAssetIds", () => {
	it("lists each shown vault asset once, in order, and ignores other sources", () => {
		const state = body(
			image("b-2"),
			{
				type: "paragraph",
				children: [{ type: "inline-image", src: "brainstorm://asset/a_1?tier=thumb" }],
			},
			image("b-2"),
			{ type: "image", src: "https://example.com/x.png" },
			{ type: "image", src: "brainstorm://asset/../../etc" },
			{ type: "image", src: "brainstorm://entity/e1" },
			{ type: "image", src: 42 },
		);
		expect(collectAssetIds(state)).toEqual(["b-2", "a_1"]);
		expect(collectAssetIds(null)).toEqual([]);
	});
});
