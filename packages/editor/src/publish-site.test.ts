import { bytesToB64 } from "@brainstorm-os/react-yjs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { type SitePlan, buildSiteArchive, planSite } from "./publish-site";

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

const SOLO = "solo";
const TEAM = "team:alice+bob";

type Vault = Record<
	string,
	{ title: string; body: Inline[][]; parent?: string; scope?: string | null }
>;

function harness(vault: Vault) {
	const loaded: string[] = [];
	const closed: string[] = [];
	const fetched: string[] = [];
	const planInput = {
		getPage: (id: string) => {
			const page = Object.hasOwn(vault, id) ? vault[id] : undefined;
			return page ? { title: page.title, parentId: page.parent ?? null } : null;
		},
		pageAccess: async (id: string) => {
			const scope = vault[id]?.scope === undefined ? SOLO : vault[id]?.scope;
			return scope ? { scope, solo: scope === SOLO } : null;
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
	};
	const buildInput = {
		fetchAsset: async (assetId: string) => {
			fetched.push(assetId);
			return { bytes: PNG, mime: "image/png" };
		},
		tokens: { "--color-text-primary": "#111111" },
		labels: LABELS,
		modifiedAt: new Date(2026, 10, 19, 10, 0, 0),
	};
	const plan = (rootId: string, maxPages?: number) =>
		planSite({ ...planInput, rootId, ...(maxPages ? { maxPages } : {}) });
	const build = (sitePlan: SitePlan, confirmedIds = sitePlan.pages.map((page) => page.id)) =>
		buildSiteArchive({ ...buildInput, plan: sitePlan, confirmedIds });
	const publish = async (rootId: string) => build(await plan(rootId));
	return { planInput, buildInput, plan, build, publish, loaded, closed, fetched };
}

const ids = (plan: SitePlan) => plan.pages.map((page) => page.id);

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

describe("planSite — which pages belong to the site", () => {
	it("admits a sub-page that names the page as its parent, transitively", async () => {
		const { plan, loaded, closed } = harness({
			root: { title: "Handbook", body: [[pageRef("a", "A")]] },
			a: { title: "Onboarding", parent: "root", body: [[pageRef("b", "B")]] },
			b: { title: "Tools", parent: "a", body: [] },
		});
		const sitePlan = await plan("root");
		expect(sitePlan.pages).toEqual([
			{ id: "root", title: "Handbook" },
			{ id: "a", title: "Onboarding" },
			{ id: "b", title: "Tools" },
		]);
		expect(sitePlan.truncated).toBe(false);
		expect(loaded).toEqual(["root", "a", "b"]);
		expect(closed).toEqual(loaded);
	});

	it("does not admit a note just because a page-ref points at it", async () => {
		const { plan, loaded } = harness({
			root: { title: "Shared", scope: TEAM, body: [[pageRef("private", "x")]] },
			private: { title: "Private diary", body: [[{ text: "Nobody may read this" }]] },
		});
		expect(ids(await plan("root"))).toEqual(["root"]);
		expect(loaded).toEqual(["root"]);
	});

	it("does not admit a planted reference to a note that is someone else's sub-page", async () => {
		const { plan } = harness({
			root: { title: "Shared", body: [[pageRef("other-child", "x")]] },
			elsewhere: { title: "Elsewhere", body: [[pageRef("other-child", "x")]] },
			"other-child": { title: "Other child", parent: "elsewhere", body: [] },
		});
		expect(ids(await plan("root"))).toEqual(["root"]);
	});

	it("does not admit a child the parent no longer shows", async () => {
		const { plan } = harness({
			root: { title: "Home", body: [[{ text: "no links" }]] },
			orphan: { title: "Orphan", parent: "root", body: [] },
		});
		expect(ids(await plan("root"))).toEqual(["root"]);
	});

	it("never widens across a sharing scope, in either direction", async () => {
		const shared = harness({
			root: { title: "Shared", scope: TEAM, body: [[pageRef("c", "x")]] },
			c: { title: "Private child", parent: "root", scope: SOLO, body: [] },
		});
		expect(ids(await shared.plan("root"))).toEqual(["root"]);
		const solo = harness({
			root: { title: "Private", scope: SOLO, body: [[pageRef("c", "x")]] },
			c: { title: "Shared child", parent: "root", scope: TEAM, body: [] },
		});
		expect(ids(await solo.plan("root"))).toEqual(["root"]);
		const other = harness({
			root: { title: "Team", scope: TEAM, body: [[pageRef("c", "x")]] },
			c: { title: "Other team", parent: "root", scope: "team:alice+carol", body: [] },
		});
		expect(ids(await other.plan("root"))).toEqual(["root"]);
	});

	it("admits a child in the very same scope as a shared root", async () => {
		const { plan } = harness({
			root: { title: "Team", scope: TEAM, body: [[pageRef("c", "x")]] },
			c: { title: "Team child", parent: "root", scope: TEAM, body: [] },
		});
		expect(ids(await plan("root"))).toEqual(["root", "c"]);
	});

	it("fails closed to the root alone when a scope cannot be read", async () => {
		const unknownChild = harness({
			root: { title: "Home", body: [[pageRef("c", "x")]] },
			c: { title: "Child", parent: "root", scope: null, body: [] },
		});
		expect(ids(await unknownChild.plan("root"))).toEqual(["root"]);
		const unknownRoot = harness({
			root: { title: "Home", scope: null, body: [[pageRef("c", "x")]] },
			c: { title: "Child", parent: "root", body: [] },
		});
		expect(ids(await unknownRoot.plan("root"))).toEqual(["root"]);
		const throwing = harness({
			root: { title: "Home", body: [[pageRef("c", "x")]] },
			c: { title: "Child", parent: "root", body: [] },
		});
		const sitePlan = await planSite({
			...throwing.planInput,
			rootId: "root",
			pageAccess: async () => {
				throw new Error("Unavailable");
			},
		});
		expect(ids(sitePlan)).toEqual(["root"]);
	});

	it("does not follow a mention or a link, and ignores prototype-named ids", async () => {
		const { plan, loaded } = harness({
			root: {
				title: "Home",
				body: [
					[mention("m", "M")],
					[{ link: "brainstorm://entity/l", text: "l" }],
					[pageRef("__proto__", "x"), pageRef("constructor", "y")],
				],
			},
			m: { title: "Mentioned", parent: "root", body: [] },
			l: { title: "Linked", parent: "root", body: [] },
		});
		expect(ids(await plan("root"))).toEqual(["root"]);
		expect(loaded).toEqual(["root"]);
	});

	it("survives a cycle of parents", async () => {
		const { plan } = harness({
			root: { title: "Home", parent: "a", body: [[pageRef("a", "A")]] },
			a: { title: "A", parent: "root", body: [[pageRef("root", "Home")]] },
		});
		expect(ids(await plan("root"))).toEqual(["root", "a"]);
	});

	it("stops at the page cap and says so", async () => {
		const { plan } = harness({
			root: { title: "Home", body: [[pageRef("a", "A"), pageRef("b", "B"), pageRef("c", "C")]] },
			a: { title: "A", parent: "root", body: [] },
			b: { title: "B", parent: "root", body: [] },
			c: { title: "C", parent: "root", body: [] },
		});
		const sitePlan = await plan("root", 2);
		expect(ids(sitePlan)).toEqual(["root", "a"]);
		expect(sitePlan.truncated).toBe(true);
	});

	it("refuses a root that is not publishable, before loading anything", async () => {
		const { plan, loaded } = harness({});
		await expect(plan("root")).rejects.toThrow(/not publishable/);
		expect(loaded).toEqual([]);
	});

	it("leaves out a sub-page whose body cannot be loaded, and closes what it opened", async () => {
		const { planInput, closed } = harness({
			root: { title: "Home", body: [[pageRef("gone", "Gone page")]] },
			gone: { title: "Gone page", parent: "root", body: [] },
		});
		const sitePlan = await planSite({
			...planInput,
			rootId: "root",
			transport: {
				...planInput.transport,
				loadDoc: async (id) => {
					if (id === "gone") throw new Error("NotFound");
					return planInput.transport.loadDoc(id);
				},
			},
		});
		expect(ids(sitePlan)).toEqual(["root"]);
		expect(closed).toEqual(["root", "gone"]);
	});
});

describe("planSite — linked pages offered as an explicit opt-in", () => {
	const linkedIds = (plan: SitePlan) => plan.linkedPages.map((page) => page.id);

	it("offers a same-scope page the tree links to but does not own, outside the default set", async () => {
		const { plan } = harness({
			root: { title: "Home", body: [[pageRef("child", "c")], [pageRef("old", "o")]] },
			child: { title: "Child", parent: "root", body: [[pageRef("old-two", "o2")]] },
			old: { title: "Old sub-page", body: [] },
			"old-two": { title: "Linked from a child", parent: "elsewhere", body: [] },
		});
		const sitePlan = await plan("root");
		expect(ids(sitePlan)).toEqual(["root", "child"]);
		expect(sitePlan.linkedPages).toEqual([
			{ id: "old", title: "Old sub-page" },
			{ id: "old-two", title: "Linked from a child" },
		]);
	});

	it("never lists a private note planted in a shared root — in either group", async () => {
		const { plan, loaded } = harness({
			root: { title: "Shared", scope: TEAM, body: [[pageRef("private", "x")]] },
			private: { title: "Private diary", scope: SOLO, body: [[{ text: "secret" }]] },
		});
		const sitePlan = await plan("root");
		expect(ids(sitePlan)).toEqual(["root"]);
		expect(linkedIds(sitePlan)).toEqual([]);
		expect(loaded).toEqual(["root"]);
	});

	it("does not offer a page whose scope differs or cannot be read", async () => {
		const { plan } = harness({
			root: { title: "Home", body: [[pageRef("team", "t"), pageRef("unknown", "u")]] },
			team: { title: "Team page", scope: TEAM, body: [] },
			unknown: { title: "Unknown", scope: null, body: [] },
		});
		expect(linkedIds(await plan("root"))).toEqual([]);
		const noRootScope = harness({
			root: { title: "Home", scope: null, body: [[pageRef("x", "x")]] },
			x: { title: "X", body: [] },
		});
		expect(linkedIds(await noRootScope.plan("root"))).toEqual([]);
	});

	it("does not follow a linked page's own links", async () => {
		const { plan, loaded } = harness({
			root: { title: "Home", body: [[pageRef("linked", "l")]] },
			linked: { title: "Linked", body: [[pageRef("further", "f")]] },
			further: { title: "Further", body: [] },
		});
		const sitePlan = await plan("root");
		expect(linkedIds(sitePlan)).toEqual(["linked"]);
		expect(loaded).toEqual(["root", "linked"]);
	});

	it("does not offer a mention target, a missing note, or a page already in the tree", async () => {
		const { plan } = harness({
			root: {
				title: "Home",
				body: [[mention("m", "M")], [pageRef("gone", "g")], [pageRef("child", "c")]],
			},
			m: { title: "Mentioned", body: [] },
			child: { title: "Child", parent: "root", body: [[pageRef("root", "r")]] },
		});
		expect(linkedIds(await plan("root"))).toEqual([]);
	});

	it("holds both groups to one page cap", async () => {
		const { plan } = harness({
			root: { title: "Home", body: [[pageRef("c", "c"), pageRef("l1", "1"), pageRef("l2", "2")]] },
			c: { title: "Child", parent: "root", body: [] },
			l1: { title: "Linked one", body: [] },
			l2: { title: "Linked two", body: [] },
		});
		const sitePlan = await plan("root", 3);
		expect(ids(sitePlan)).toEqual(["root", "c"]);
		expect(linkedIds(sitePlan)).toEqual(["l1"]);
		expect(sitePlan.truncated).toBe(true);
	});
});

describe("buildSiteArchive — linked pages", () => {
	const vault = (withLinked: boolean) => ({
		root: { title: "Home", body: [[pageRef("child", "c")], [pageRef("old", "stored label")]] },
		child: { title: "Child", parent: "root", body: [[image("child-asset")]] },
		...(withLinked
			? { old: { title: "Old sub-page", body: [[{ text: "old body" }], [image("old-asset")]] } }
			: {}),
	});

	it("leaves a linked page out by default, byte for byte as if it were not offered", async () => {
		const offered = harness(vault(true));
		const plan = await offered.plan("root");
		expect(plan.linkedPages).toHaveLength(1);
		const byDefault = await offered.build(plan);
		const absent = harness(vault(false));
		const before = await absent.build(await absent.plan("root"));
		expect(byDefault.bytes).toEqual(before.bytes);
		expect(byDefault.pageCount).toBe(2);
		expect(offered.fetched).toEqual(["child-asset"]);
		expect(everything(byDefault.bytes)).not.toMatch(/Old sub-page|old body/);
	});

	it("publishes a linked page only when it is ticked", async () => {
		const { plan, build, fetched } = harness(vault(true));
		const archive = await build(await plan("root"), ["root", "child", "old"]);
		expect(archive.pageCount).toBe(3);
		const site = unzip(archive.bytes);
		expect([...site.keys()]).toEqual([
			"index.html",
			"child.html",
			"old-sub-page.html",
			"styles.css",
			"assets/1.png",
			"assets/2.png",
		]);
		expect(site.get("index.html")).toContain('<a href="old-sub-page.html">Old sub-page</a>');
		expect(site.get("old-sub-page.html")).toContain("old body");
		expect(fetched).toEqual(["child-asset", "old-asset"]);
	});

	it("does not write to the vault when a linked page is published", async () => {
		const { planInput, buildInput } = harness(vault(true));
		const calls: string[] = [];
		const transport = new Proxy(planInput.transport, {
			get: (target, key: string) => {
				calls.push(key);
				return target[key as keyof typeof target];
			},
		});
		const plan = await planSite({ ...planInput, transport, rootId: "root" });
		await buildSiteArchive({ ...buildInput, plan, confirmedIds: ["old"] });
		expect(new Set(calls)).toEqual(new Set(["loadDoc", "closeDoc"]));
	});
});

describe("buildSiteArchive", () => {
	it("writes the confirmed pages with links between them", async () => {
		const { publish } = harness({
			root: { title: "Handbook", body: [[{ text: "Start: " }, pageRef("a", "stale label")]] },
			a: {
				title: "Onboarding",
				parent: "root",
				body: [[pageRef("b", "Tools")], [mention("root", "Handbook")]],
			},
			b: { title: "Tools", parent: "a", body: [[{ text: "Use them." }]] },
		});
		const archive = await publish("root");
		expect(archive.pageCount).toBe(3);
		const site = unzip(archive.bytes);
		expect([...site.keys()]).toEqual(["index.html", "onboarding.html", "tools.html", "styles.css"]);
		expect(site.get("index.html")).toContain('Start: <a href="onboarding.html">Onboarding</a>');
		expect(site.get("onboarding.html")).toContain('<a href="tools.html">Tools</a>');
		expect(site.get("onboarding.html")).toContain('<a href="index.html">Handbook</a>');
		expect(site.get("tools.html")).toContain("<p>Use them.</p>");
	});

	it("publishes only what was confirmed — an unticked sub-page is as absent as a stranger", async () => {
		const { plan, build } = harness({
			root: { title: "Home", body: [[pageRef("a", "A")], [pageRef("b", "B")]] },
			a: { title: "Kept page", parent: "root", body: [] },
			b: { title: "Dropped page", parent: "root", body: [[{ text: "dropped body" }]] },
		});
		const archive = await build(await plan("root"), ["root", "a"]);
		expect(archive.pageCount).toBe(2);
		const site = unzip(archive.bytes);
		expect([...site.keys()]).toEqual(["index.html", "kept-page.html", "styles.css"]);
		expect(everything(archive.bytes)).not.toMatch(/Dropped page|dropped body/);
	});

	it("ignores a confirmed id that was never in the plan, and always keeps the root", async () => {
		const { plan, build } = harness({
			root: { title: "Home", body: [[pageRef("a", "A")]] },
			a: { title: "A page", parent: "root", body: [] },
			stranger: { title: "Stranger", body: [[{ text: "stranger body" }]] },
		});
		const archive = await build(await plan("root"), ["stranger", "a"]);
		expect([...unzip(archive.bytes).keys()]).toEqual(["index.html", "a-page.html", "styles.css"]);
		expect(everything(archive.bytes)).not.toContain("tranger");
	});

	it("rewrites an entity link between published pages", async () => {
		const { publish } = harness({
			root: {
				title: "Home",
				body: [[pageRef("a", "A")], [{ link: "brainstorm://entity/a", text: "read A" }]],
			},
			a: { title: "A page", parent: "root", body: [] },
		});
		const site = unzip((await publish("root")).bytes);
		expect(site.get("index.html")).toContain('<a href="a-page.html" rel="noreferrer">read A</a>');
	});
});

describe("buildSiteArchive — what leaves the vault", () => {
	const SECRET = "5e0c1e7a-0000-4000-8000-secretsecret";
	const SECRET_TITLE = "Severance terms";
	const SECRET_BODY = "Nobody may read this";

	it("publishes nothing of a private note a collaborator planted a page-ref to", async () => {
		const { publish, loaded, fetched } = harness({
			root: {
				title: "Shared page",
				scope: TEAM,
				body: [
					[pageRef(SECRET, SECRET_TITLE)],
					[mention(SECRET, SECRET_TITLE)],
					[{ link: `brainstorm://entity/${SECRET}`, text: "the terms" }],
					[{ decorator: "transclusion", props: { entityId: SECRET, label: SECRET_TITLE } }],
					[{ text: `raw brainstorm://entity/${SECRET} url` }],
				],
			},
			[SECRET]: { title: SECRET_TITLE, body: [[{ text: SECRET_BODY }], [image("secret-asset")]] },
		});
		const archive = await publish("root");
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
		const root = "11111111-aaaa-4aaa-8aaa-111111111111";
		const sub = "22222222-bbbb-4bbb-8bbb-222222222222";
		const { publish } = harness({
			[root]: { title: "Home", body: [[pageRef(sub, "Sub")]] },
			[sub]: { title: "Sub", parent: root, body: [[mention(root, "Home")]] },
		});
		const raw = everything((await publish(root)).bytes);
		expect(raw).not.toContain(root);
		expect(raw).not.toContain(sub);
	});

	it("copies assets for confirmed private pages only, once each, and never names them", async () => {
		const { publish, fetched } = harness({
			root: { title: "Home", body: [[image("asset-one")], [pageRef("a", "A")]] },
			a: { title: "A", parent: "root", body: [[image("asset-one")], [image("asset-two")]] },
		});
		const archive = await publish("root");
		expect(fetched).toEqual(["asset-one", "asset-two"]);
		expect(archive.withheldAssets).toBe(0);
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

	it("does not fetch an asset for a page that was not confirmed", async () => {
		const { plan, build, fetched } = harness({
			root: { title: "Home", body: [[pageRef("a", "A")]] },
			a: { title: "A", parent: "root", body: [[image("unconfirmed-asset")]] },
		});
		await build(await plan("root"), ["root"]);
		expect(fetched).toEqual([]);
	});

	it("withholds every vault image on a page other people can write, and counts them", async () => {
		const { publish, fetched } = harness({
			root: {
				title: "Shared",
				scope: TEAM,
				body: [[image("planted-private-asset")], [image("own-upload")]],
			},
		});
		const archive = await publish("root");
		expect(fetched).toEqual([]);
		expect(archive.withheldAssets).toBe(2);
		const site = unzip(archive.bytes);
		expect([...site.keys()]).toEqual(["index.html", "styles.css"]);
		expect(site.get("index.html")).not.toContain("<img");
		expect(everything(archive.bytes)).not.toMatch(/planted-private-asset|own-upload/);
	});

	it("stops copying images at the size cap, fetches no more, and counts what it left out", async () => {
		const { plan, buildInput, fetched } = harness({
			root: { title: "Home", body: [[image("a1"), image("a2"), image("a3"), image("a4")]] },
		});
		const sitePlan = await plan("root");
		const archive = await buildSiteArchive({
			...buildInput,
			plan: sitePlan,
			confirmedIds: ["root"],
			maxAssetBytes: PNG.length * 2 + 1,
		});
		expect(archive.skippedAssets).toBe(2);
		expect(fetched).toEqual(["a1", "a2", "a3"]);
		const site = unzip(archive.bytes);
		expect([...site.keys()]).toEqual(["index.html", "styles.css", "assets/1.png", "assets/2.png"]);
	});

	it("counts inline data images against the same cap", async () => {
		const big = `data:image/png;base64,${"A".repeat(4000)}`;
		const small = "data:image/png;base64,AAAA";
		const dataImage = (src: string): Inline => ({
			decorator: "image-block",
			props: { src, alt: "" },
		});
		const { plan, buildInput, fetched } = harness({
			root: {
				title: "Home",
				body: [[dataImage(big)], [dataImage(small)], [dataImage(big)], [image("vault-asset")]],
			},
		});
		const archive = await buildSiteArchive({
			...buildInput,
			plan: await plan("root"),
			confirmedIds: ["root"],
			maxAssetBytes: 1024,
		});
		expect(archive.bytes.length).toBeLessThan(6000);
		expect(archive.skippedAssets).toBe(2);
		const home = unzip(archive.bytes).get("index.html") ?? "";
		expect(home.match(/<img/g)).toHaveLength(2);
		expect(home).toContain(small);
		expect(home).not.toContain("AAAAAAAA");
		expect(fetched).toEqual(["vault-asset"]);
	});

	it("drops an image whose fetch fails instead of failing the site", async () => {
		const { plan, buildInput } = harness({ root: { title: "Home", body: [[image("x")]] } });
		const archive = await buildSiteArchive({
			...buildInput,
			plan: await plan("root"),
			confirmedIds: ["root"],
			fetchAsset: async () => {
				throw new Error("blocked");
			},
		});
		const site = unzip(archive.bytes);
		expect([...site.keys()]).toEqual(["index.html", "styles.css"]);
		expect(site.get("index.html")).not.toContain("<img");
	});

	it("references nothing outside the archive: no remote image, stylesheet, script or frame", async () => {
		const remote = (type: string): Inline => ({
			decorator: type,
			props: { src: "https://tracker.example/pixel.gif", alt: "" },
		});
		const { plan, buildInput } = harness({
			root: {
				title: "Home",
				body: [
					[remote("image-block"), remote("inline-image"), remote("image")],
					[{ decorator: "web-embed", props: { url: "https://www.youtube.com/watch?v=x" } }],
					[pageRef("a", "A")],
				],
			},
			a: { title: "A", parent: "root", body: [[remote("image-block")]] },
		});
		const archive = await buildSiteArchive({
			...buildInput,
			plan: await plan("root"),
			confirmedIds: ["root", "a"],
			tokens: {
				"--color-a": 'image-set("https://tracker.example/a.png" 1x)',
				"--color-b": "cross-fade(url(https://tracker.example/b.png), red)",
				"--color-c": "#123456",
			},
		});
		for (const [path, content] of unzip(archive.bytes)) {
			if (path.endsWith(".css")) {
				expect(content).not.toMatch(/https?:|\/\/|url\(|image-set|cross-fade|@import/i);
				continue;
			}
			expect(content).not.toMatch(/<(script|iframe|object|embed|video|audio|source)\b/i);
			expect(content).not.toMatch(/\bsrc(set)?\s*=\s*["']?\s*(https?:)?\/\//i);
			for (const [, target] of content.matchAll(/<link[^>]*href="([^"]*)"/g)) {
				expect(target).toBe("styles.css");
			}
			expect(content).not.toContain("tracker.example");
		}
	});

	it("escapes markup in a body and in titles", async () => {
		const { publish } = harness({
			root: {
				title: "<script>alert(1)</script>",
				body: [[{ text: '<img src=x onerror="alert(2)">' }], [pageRef("a", "<b>bold</b>")]],
			},
			a: { title: '"><svg onload=alert(3)>', parent: "root", body: [] },
		});
		const site = unzip((await publish("root")).bytes);
		for (const [path, content] of site) {
			if (!path.endsWith(".html")) continue;
			expect(content).not.toMatch(/<script|<img src=x|<svg|<b>/);
		}
		expect([...site.keys()]).toContain("svg-onload-alert-3.html");
	});

	it("keeps a path-shaped title from shaping the path", async () => {
		const { publish } = harness({
			root: { title: "Home", body: [[pageRef("a", "x"), pageRef("b", "y")]] },
			a: { title: "../../../etc/cron.d/job", parent: "root", body: [] },
			b: { title: "/abs\\path:evil", parent: "root", body: [] },
		});
		const site = unzip((await publish("root")).bytes);
		expect([...site.keys()]).toEqual([
			"index.html",
			"etc-cron-d-job.html",
			"abs-path-evil.html",
			"styles.css",
		]);
	});
});
