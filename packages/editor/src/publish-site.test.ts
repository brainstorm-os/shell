import { bytesToB64 } from "@brainstorm-os/react-yjs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildSiteArchive } from "./publish-site";

const LABELS = { pages: "Pages", untitled: "Untitled", unpublished: "[unpublished]" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

type Inline =
	| { text: string }
	| { decorator: string; props: Record<string, string> }
	| { link: string; text: string };

/** A body in the `@lexical/yjs` encoding the shell hands back from `loadDoc`:
 *  one paragraph per entry, each a run of text, decorators and links. */
function snapshot(paragraphs: Inline[][]): string {
	const doc = new Y.Doc();
	const root = doc.get("root", Y.XmlText);
	const appendText = (parent: Y.XmlText, value: string) => {
		const props = new Y.Map<unknown>();
		props.set("__type", "text");
		props.set("__format", 0);
		parent.insertEmbed(parent.length, props);
		parent.insert(parent.length, value);
	};
	for (const inlines of paragraphs) {
		const paragraph = new Y.XmlText();
		root.insertEmbed(root.length, paragraph);
		paragraph.setAttribute("__type", "paragraph");
		for (const inline of inlines) {
			if ("decorator" in inline) {
				const element = new Y.XmlElement(inline.decorator);
				paragraph.insertEmbed(paragraph.length, element);
				element.setAttribute("__type", inline.decorator);
				for (const [key, value] of Object.entries(inline.props)) {
					element.setAttribute(`__${key}`, value);
				}
			} else if ("link" in inline) {
				const link = new Y.XmlText();
				paragraph.insertEmbed(paragraph.length, link);
				link.setAttribute("__type", "link");
				link.setAttribute("__url", inline.link);
				appendText(link, inline.text);
			} else {
				appendText(paragraph, inline.text);
			}
		}
	}
	const encoded = bytesToB64(Y.encodeStateAsUpdate(doc));
	doc.destroy();
	return encoded;
}

const pageRef = (entityId: string, label: string): Inline => ({
	decorator: "page-ref",
	props: { entityId, entityType: "brainstorm/Note/v1", label },
});
const mention = (entityId: string, label: string): Inline => ({
	decorator: "mention",
	props: { entityId, entityType: "brainstorm/Note/v1", label },
});
const image = (assetId: string): Inline => ({
	decorator: "image-block",
	props: { src: `brainstorm://asset/${assetId}`, alt: "" },
});

type Vault = Record<string, { title: string; body: Inline[][] }>;

function harness(vault: Vault, publishable: readonly string[] = Object.keys(vault)) {
	const loaded: string[] = [];
	const closed: string[] = [];
	const fetched: string[] = [];
	const input = {
		getPage: (id: string) => {
			const page = publishable.includes(id) ? vault[id] : undefined;
			return page ? { title: page.title } : null;
		},
		transport: {
			loadDoc: async (id: string) => {
				loaded.push(id);
				const page = vault[id];
				if (!page) throw new Error("NotFound");
				return { snapshotB64: snapshot(page.body) };
			},
			closeDoc: async (id: string) => {
				closed.push(id);
			},
		},
		fetchAsset: async (assetId: string) => {
			fetched.push(assetId);
			return { bytes: PNG, mime: "image/png" };
		},
		tokens: { "--color-text-primary": "#111111" },
		labels: LABELS,
		modifiedAt: new Date(2026, 10, 19, 10, 0, 0),
	};
	return { input, loaded, closed, fetched };
}

/** Entry name → text for a store-only archive (data sits verbatim). */
function unzip(archive: Uint8Array): Map<string, string> {
	const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
	const decoder = new TextDecoder();
	const end = archive.length - 22;
	const count = view.getUint16(end + 10, true);
	let at = view.getUint32(end + 16, true);
	const out = new Map<string, string>();
	for (let n = 0; n < count; n += 1) {
		const size = view.getUint32(at + 20, true);
		const nameLength = view.getUint16(at + 28, true);
		const local = view.getUint32(at + 42, true);
		const name = decoder.decode(archive.subarray(at + 46, at + 46 + nameLength));
		const data = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
		out.set(name, decoder.decode(archive.subarray(data, data + size)));
		at += 46 + nameLength;
	}
	return out;
}

/** The whole archive as one string — for "this never appears anywhere". */
const everything = (archive: Uint8Array) => new TextDecoder("latin1").decode(archive);

describe("buildSiteArchive", () => {
	it("publishes the root and its sub-pages, transitively, with links between them", async () => {
		const { input, loaded, closed } = harness({
			root: { title: "Handbook", body: [[{ text: "Start: " }, pageRef("a", "Onboarding")]] },
			a: { title: "Onboarding", body: [[pageRef("b", "Tools")], [pageRef("root", "Handbook")]] },
			b: { title: "Tools", body: [[{ text: "Use them." }]] },
		});
		const archive = await buildSiteArchive({ ...input, rootId: "root" });
		expect(archive.pageCount).toBe(3);
		expect(archive.truncated).toBe(false);
		const site = unzip(archive.bytes);
		expect([...site.keys()]).toEqual(["index.html", "onboarding.html", "tools.html", "styles.css"]);
		expect(site.get("index.html")).toContain('Start: <a href="onboarding.html">Onboarding</a>');
		expect(site.get("onboarding.html")).toContain('<a href="tools.html">Tools</a>');
		expect(site.get("onboarding.html")).toContain('<a href="index.html">Handbook</a>');
		expect(site.get("tools.html")).toContain("<p>Use them.</p>");
		expect(loaded).toEqual(["root", "a", "b"]);
		expect(closed).toEqual(loaded);
	});

	it("rewrites an entity link between published pages", async () => {
		const { input } = harness({
			root: {
				title: "Home",
				body: [[pageRef("a", "A")], [{ link: "brainstorm://entity/a", text: "read A" }]],
			},
			a: { title: "A page", body: [] },
		});
		const site = unzip((await buildSiteArchive({ ...input, rootId: "root" })).bytes);
		expect(site.get("index.html")).toContain('<a href="a-page.html" rel="noreferrer">read A</a>');
	});

	it("does not follow a mention or a link into the set — only a sub-page does", async () => {
		const { input, loaded } = harness({
			root: {
				title: "Home",
				body: [[mention("m", "Mentioned")], [{ link: "brainstorm://entity/l", text: "linked" }]],
			},
			m: { title: "Mentioned", body: [] },
			l: { title: "Linked", body: [] },
		});
		const archive = await buildSiteArchive({ ...input, rootId: "root" });
		expect(archive.pageCount).toBe(1);
		expect(loaded).toEqual(["root"]);
	});

	it("stops at the page cap and says so", async () => {
		const { input } = harness({
			root: { title: "Home", body: [[pageRef("a", "A"), pageRef("b", "B"), pageRef("c", "C")]] },
			a: { title: "A", body: [] },
			b: { title: "B", body: [] },
			c: { title: "C", body: [] },
		});
		const archive = await buildSiteArchive({ ...input, rootId: "root", maxPages: 2 });
		expect(archive.pageCount).toBe(2);
		expect(archive.truncated).toBe(true);
		const site = unzip(archive.bytes);
		expect([...site.keys()]).toEqual(["index.html", "a.html", "styles.css"]);
		expect(site.get("index.html")).not.toContain(">B<");
	});

	it("refuses a root that is not publishable, before loading anything", async () => {
		const { input, loaded } = harness({ root: { title: "Home", body: [] } }, []);
		await expect(buildSiteArchive({ ...input, rootId: "root" })).rejects.toThrow(/not publishable/);
		expect(loaded).toEqual([]);
	});

	it("leaves out a sub-page whose body cannot be loaded, and closes what it opened", async () => {
		const { input, closed } = harness({
			root: { title: "Home", body: [[pageRef("gone", "Gone page")]] },
			gone: { title: "Gone page", body: [] },
		});
		const archive = await buildSiteArchive({
			...input,
			rootId: "root",
			transport: {
				...input.transport,
				loadDoc: async (id) => {
					if (id === "gone") throw new Error("NotFound");
					return input.transport.loadDoc(id);
				},
			},
		});
		const site = unzip(archive.bytes);
		expect([...site.keys()]).toEqual(["index.html", "styles.css"]);
		expect(site.get("index.html")).not.toContain("Gone page");
		expect(closed).toEqual(["root", "gone"]);
	});
});

describe("buildSiteArchive — what leaves the vault", () => {
	const SECRET = "5e0c1e7a-0000-4000-8000-secretsecret";
	const SECRET_TITLE = "Severance terms";
	const SECRET_BODY = "Nobody may read this";

	it("publishes nothing of an entity outside the set: no body, title, id or assets", async () => {
		const { input, loaded, fetched } = harness(
			{
				root: {
					title: "Public",
					body: [
						[pageRef(SECRET, SECRET_TITLE)],
						[mention(SECRET, SECRET_TITLE)],
						[{ link: `brainstorm://entity/${SECRET}`, text: "the terms" }],
						[{ decorator: "transclusion", props: { entityId: SECRET, label: SECRET_TITLE } }],
						[{ text: `raw brainstorm://entity/${SECRET} url` }],
					],
				},
				[SECRET]: { title: SECRET_TITLE, body: [[{ text: SECRET_BODY }], [image("secret-asset")]] },
			},
			["root"],
		);
		const archive = await buildSiteArchive({ ...input, rootId: "root" });
		expect(archive.pageCount).toBe(1);
		expect(loaded).toEqual(["root"]);
		expect(fetched).toEqual([]);
		const raw = everything(archive.bytes);
		expect(raw).not.toContain(SECRET);
		expect(raw).not.toContain(SECRET_TITLE);
		expect(raw).not.toContain(SECRET_BODY);
		expect(raw).not.toContain("secret-asset");
		expect(raw).not.toContain("brainstorm:");
		const home = unzip(archive.bytes).get("index.html") ?? "";
		expect(home.match(/\[unpublished\]/g)).toHaveLength(4);
		expect(home).toContain("<p>the terms</p>");
	});

	it("never writes any entity id, published or not", async () => {
		const ids = {
			root: "11111111-aaaa-4aaa-8aaa-111111111111",
			sub: "22222222-bbbb-4bbb-8bbb-222222222222",
		};
		const { input } = harness({
			[ids.root]: { title: "Home", body: [[pageRef(ids.sub, "Sub")]] },
			[ids.sub]: { title: "Sub", body: [[mention(ids.root, "Home")]] },
		});
		const raw = everything((await buildSiteArchive({ ...input, rootId: ids.root })).bytes);
		expect(raw).not.toContain(ids.root);
		expect(raw).not.toContain(ids.sub);
	});

	it("fetches assets for published pages only, once each, and never names them", async () => {
		const { input, fetched } = harness({
			root: { title: "Home", body: [[image("asset-one")], [pageRef("a", "A")]] },
			a: { title: "A", body: [[image("asset-one")], [image("asset-two")]] },
		});
		const archive = await buildSiteArchive({ ...input, rootId: "root" });
		expect(fetched).toEqual(["asset-one", "asset-two"]);
		const site = unzip(archive.bytes);
		expect([...site.keys()]).toEqual([
			"index.html",
			"a.html",
			"styles.css",
			"assets/1.png",
			"assets/2.png",
		]);
		expect(site.get("a.html")).toContain('<img src="assets/1.png"');
		expect(everything(archive.bytes)).not.toMatch(/asset-(one|two)/);
	});

	it("drops an image whose fetch fails instead of failing the site", async () => {
		const { input } = harness({ root: { title: "Home", body: [[image("x")]] } });
		const archive = await buildSiteArchive({
			...input,
			rootId: "root",
			fetchAsset: async () => {
				throw new Error("blocked");
			},
		});
		const site = unzip(archive.bytes);
		expect([...site.keys()]).toEqual(["index.html", "styles.css"]);
		expect(site.get("index.html")).not.toContain("<img");
	});

	it("escapes markup in a body and in titles", async () => {
		const { input } = harness({
			root: {
				title: "<script>alert(1)</script>",
				body: [[{ text: '<img src=x onerror="alert(2)">' }], [pageRef("a", "<b>bold</b>")]],
			},
			a: { title: '"><svg onload=alert(3)>', body: [] },
		});
		const site = unzip((await buildSiteArchive({ ...input, rootId: "root" })).bytes);
		for (const [path, content] of site) {
			if (!path.endsWith(".html")) continue;
			expect(content).not.toMatch(/<script|<img src=x|<svg|<b>/);
		}
		expect([...site.keys()]).toContain("svg-onload-alert-3.html");
	});

	it("keeps a path-shaped title from shaping the path", async () => {
		const { input } = harness({
			root: { title: "Home", body: [[pageRef("a", "x"), pageRef("b", "y")]] },
			a: { title: "../../../etc/cron.d/job", body: [] },
			b: { title: "/abs\\path:evil", body: [] },
		});
		const site = unzip((await buildSiteArchive({ ...input, rootId: "root" })).bytes);
		expect([...site.keys()]).toEqual([
			"index.html",
			"etc-cron-d-job.html",
			"abs-path-evil.html",
			"styles.css",
		]);
	});
});
