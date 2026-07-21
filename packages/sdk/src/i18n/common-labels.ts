/**
 * `@brainstorm-os/sdk/i18n` — the ONE localisation source for the SDK's
 * shared cross-app surfaces (the icon + cover pickers). Every app embeds
 * the same `<IconPicker>` / `<CoverPicker>` chrome; rather than each app
 * re-declaring the same ~26 strings in its own `t()` manifest (or, worse,
 * hardcoding English per host), the canonical English lives here once.
 *
 * Hosts pass nothing to get these defaults; a localised host passes a
 * `Partial<…Labels>` of just the keys it translates (merged over the
 * defaults). This keeps the per-app i18n manifests free of common-UI
 * boilerplate while preserving the SDK i18n convention (no bare strings
 * inside the components — they read from a labels object either way).
 */

/** Every user-visible string in the icon-picker chrome. */
export type IconPickerLabels = {
	region: string;
	close: string;
	remove: string;
	search: string;
	noMatch: string;
	tabEmoji: string;
	tabIcon: string;
	tabUpload: string;
	tabLibrary: string;
	uploadPending: string;
	libraryPending: string;
	/** Upload tab: the browse-for-image affordance + in-flight + empty-library
	 *  states (used when a host wires an `iconUpload` service; otherwise the
	 *  `*Pending` placeholders show). */
	uploadAction: string;
	uploading: string;
	libraryEmpty: string;
	skinToneRegion: string;
	/** Per-tone option label, `{tone}` substituted with the friendly tone
	 *  name from `skinToneNames`. Drives the radio's accessible name. */
	skinToneOption: string;
	/** Friendly names for each Fitzpatrick modifier; defaults are English
	 *  ("Default", "Light", "Medium-light", …). Keys are SkinTone values. */
	skinToneNames: {
		none: string;
		light: string;
		mediumLight: string;
		medium: string;
		mediumDark: string;
		dark: string;
	};
	tintRegion: string;
	/** Per-swatch option label, `{color}` substituted with the swatch's
	 *  hex value (palette is intentionally not localised). */
	tintOption: string;
	tintCustom: string;
};

/** Every user-visible string in the cover-picker chrome. The gradient
 *  and solid-colour palettes share ONE tab (`tabGallery` / the
 *  `galleryRegion` grid label) — they're the same kind of pick. */
export type CoverPickerLabels = {
	region: string;
	close: string;
	remove: string;
	tabImage: string;
	/** The combined gradients-and-colours tab. */
	tabGallery: string;
	/** The focal-point framing tab (shown only while an image is staged). */
	tabReposition: string;
	upload: string;
	uploading: string;
	/** Drop-zone affordance, e.g. "Drag an image here, or click to browse". */
	dropHint: string;
	libraryEmpty: string;
	focalHint: string;
	useCover: string;
	/** Region label for the combined gradient + colour swatch grid. */
	galleryRegion: string;
};

/** The shared in-app back/forward control (`@brainstorm-os/sdk/nav-history`).
 *  Every app embeds the same two buttons; the canonical English lives here
 *  once so per-app `t()` manifests stay free of this boilerplate. */
export type NavLabels = {
	/** Region label for the back/forward button group. */
	region: string;
	back: string;
	forward: string;
};

export const DEFAULT_NAV_LABELS: NavLabels = {
	region: "Navigation history",
	back: "Back",
	forward: "Forward",
};

/** Shared find & replace strings (doc 59) — same default-then-override
 *  pattern as `DEFAULT_NAV_LABELS`; the `<FindBar>` (B9.1b) and every
 *  text app's `editor.find.*` keys resolve through one source so the bar
 *  reads identically everywhere. `{current}`/`{total}` are substituted
 *  by the host `t()`. */
export type FindLabels = {
	region: string;
	term: string;
	replacement: string;
	matchCount: string;
	noResults: string;
	next: string;
	previous: string;
	close: string;
	replace: string;
	replaceAll: string;
	caseSensitive: string;
	wholeWord: string;
	regex: string;
	inSelection: string;
};

export const DEFAULT_FIND_LABELS: FindLabels = {
	region: "Find in document",
	term: "Find",
	replacement: "Replace with",
	matchCount: "{current} of {total}",
	noResults: "No results",
	next: "Next match",
	previous: "Previous match",
	close: "Close find",
	replace: "Replace",
	replaceAll: "Replace all",
	caseSensitive: "Match case",
	wholeWord: "Whole word",
	regex: "Regular expression",
	inSelection: "In selection",
};

export const DEFAULT_ICON_PICKER_LABELS: IconPickerLabels = {
	region: "Pick icon",
	close: "Close",
	remove: "Remove icon",
	search: "Search",
	noMatch: "No matches",
	tabEmoji: "Emoji",
	tabIcon: "Icon",
	tabUpload: "Upload",
	tabLibrary: "Library",
	uploadPending: "Custom-image uploads land with the entities write half.",
	libraryPending: "Your uploaded icons will appear here.",
	uploadAction: "Choose image…",
	uploading: "Uploading…",
	libraryEmpty: "No custom icons yet — upload one from the Upload tab.",
	skinToneRegion: "Skin tone",
	skinToneOption: "Skin tone: {tone}",
	skinToneNames: {
		none: "Default",
		light: "Light",
		mediumLight: "Medium-light",
		medium: "Medium",
		mediumDark: "Medium-dark",
		dark: "Dark",
	},
	tintRegion: "Icon colour",
	tintOption: "Colour {color}",
	tintCustom: "Custom colour",
};

export const DEFAULT_COVER_PICKER_LABELS: CoverPickerLabels = {
	region: "Pick cover",
	close: "Close",
	remove: "Remove cover",
	tabImage: "Image",
	tabGallery: "Color",
	tabReposition: "Reposition",
	upload: "Upload image",
	uploading: "Uploading…",
	dropHint: "Drag an image here, or click to browse",
	libraryEmpty: "No covers uploaded yet.",
	focalHint: "Drag to choose the focal point.",
	useCover: "Use cover",
	galleryRegion: "Gradient and colour covers",
};

/** Every user-visible string in the shared `<InlinePropertyForm>` — the
 *  light-touch property constructor embedded in the add-property picker's
 *  "create new" mode. A localised host passes a `Partial` of just the keys
 *  it translates; everything else falls back to these English defaults. */
export type InlinePropertyFormLabels = {
	region: string;
	back: string;
	nameLabel: string;
	namePlaceholder: string;
	kindLabel: string;
	formatLabel: string;
	multiLabel: string;
	cancel: string;
	submit: string;
	moreOptionsHint?: string;
	kindText: string;
	kindNumber: string;
	kindBoolean: string;
	kindDate: string;
	kindSelect: string;
	kindRelation: string;
	kindFile: string;
	kindFormula: string;
	formulaLabel: string;
	formulaPlaceholder: string;
	formulaHint: string;
	formatPlain: string;
	formatUrl: string;
	formatEmail: string;
	formatPhone: string;
	formatCurrency: string;
	formatPercent: string;
	formatDuration: string;
	currencyLabel: string;
	optionsLabel: string;
	optionsPlaceholder: string;
	optionsHint: string;
	relationTargetLabel: string;
	relationTargetAny: string;
};

export const DEFAULT_INLINE_PROPERTY_FORM_LABELS: InlinePropertyFormLabels = {
	region: "New property",
	back: "Back",
	nameLabel: "Name",
	namePlaceholder: "Property name",
	kindLabel: "Type",
	formatLabel: "Format",
	multiLabel: "Allow multiple values",
	cancel: "Cancel",
	submit: "Create",
	moreOptionsHint: "More options in Settings → Data.",
	kindText: "Text",
	kindNumber: "Number",
	kindBoolean: "Checkbox",
	kindDate: "Date",
	kindSelect: "Select",
	kindRelation: "Relation",
	kindFile: "File",
	kindFormula: "Formula",
	formulaLabel: "Expression",
	formulaPlaceholder: "{price} * {quantity}",
	formulaHint: "Reference other properties with {braces}. Read-only, computed per row.",
	formatPlain: "Plain",
	formatUrl: "URL",
	formatEmail: "Email",
	formatPhone: "Phone",
	formatCurrency: "Currency",
	formatPercent: "Percent",
	formatDuration: "Duration",
	currencyLabel: "Currency code",
	optionsLabel: "Options",
	optionsPlaceholder: "Lead\nQualified\nWon",
	optionsHint: "One per line, or comma-separated.",
	relationTargetLabel: "Links to",
	relationTargetAny: "Anything",
};

/** Every user-visible string in the shared add-property picker chrome.
 *  `types` carries the humanised per-category captions; `form` nests the
 *  inline-constructor labels (create-new mode). Hosts pass a `Partial`
 *  merged over these English defaults. */
export type AddPropertyPickerLabels = {
	region: string;
	search: string;
	searchPlaceholder: string;
	results: string;
	empty: string;
	emptyCatalog: string;
	loading: string;
	createNew: string;
	/** `{type}` substituted with the per-category caption. */
	typeMulti: string;
	types: {
		text: string;
		number: string;
		boolean: string;
		date: string;
		select: string;
		url: string;
		email: string;
		phone: string;
		file: string;
		reference: string;
		"rich-text": string;
	};
	form: InlinePropertyFormLabels;
};

export const DEFAULT_ADD_PROPERTY_PICKER_LABELS: AddPropertyPickerLabels = {
	region: "Add property",
	search: "Search properties",
	searchPlaceholder: "Search properties…",
	results: "Property suggestions",
	empty: "No matches",
	emptyCatalog: "No properties in this vault yet.",
	loading: "Loading properties…",
	createNew: "Create new property",
	typeMulti: "{type} · Multiple",
	types: {
		text: "Text",
		number: "Number",
		boolean: "Checkbox",
		date: "Date",
		select: "Select",
		url: "URL",
		email: "Email",
		phone: "Phone",
		file: "File",
		reference: "Reference",
		"rich-text": "Rich text",
	},
	form: DEFAULT_INLINE_PROPERTY_FORM_LABELS,
};

/**
 * `createT` — the app-side `t()`. Every first-party app needs the exact
 * same primitive the shell's `renderer/i18n/t.ts` is: a typed lookup over a
 * default-English manifest with `{name}`-style interpolation and an
 * override layer. Rather than each app re-implementing it (and drifting on
 * the interpolation rule / missing-key behaviour), the canonical
 * implementation lives here so "every user-visible string wraps in t(key)"
 * is one shared helper, not N copies.
 *
 * `M` is the app's manifest object (`{ key: "English default" }`).
 * `overrides` is a `Partial<M>` of just the keys a localised build
 * translates. The returned `t` is fully typed: `key` must be a manifest
 * key; an unknown key (only reachable via a cast) degrades to the key
 * string so a missing translation is visible, never a crash.
 */
export type TParams = Record<string, string | number>;

export type TFunction<M extends Record<string, string>> = (
	key: keyof M,
	params?: TParams,
) => string;

export function createT<M extends Record<string, string>>(
	manifest: M,
	overrides?: Partial<M>,
): TFunction<M> {
	const merged: M = overrides ? { ...manifest, ...overrides } : manifest;
	return (key, params) => {
		const template = merged[key] ?? String(key);
		if (!params) return template;
		return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
			Object.hasOwn(params, name) ? String(params[name]) : whole,
		);
	};
}

/**
 * The blessed app-side plural pattern. `createT` does `{name}` interpolation
 * only — it deliberately does **not** parse ICU (`{count, plural, …}`) so a
 * sandboxed app needn't bundle a full message formatter. An app that wrote an
 * ICU plural string against `createT` would leak the raw template to the UI
 * (the regex above can't match the comma after the var). So plurals route
 * through TWO catalog keys — `<base>.one` / `<base>.other`, each a normal
 * `{count}`-interpolated string — and this helper picks between them.
 *
 * The English `count === 1` selection lives here, in the shared i18n
 * primitive (the sanctioned place), never inlined in component code — so the
 * `35-code-conventions.md` "no `count === 1 ?` branch in components" rule
 * holds. `{count}` is injected automatically; pass extra `params` for any
 * other tokens in the strings.
 *
 *   "items.one": "{count} item", "items.other": "{count} items"
 *   plural(t, n, "items.one", "items.other")  // → "1 item" / "3 items"
 */
export function plural<M extends Record<string, string>>(
	t: TFunction<M>,
	count: number,
	oneKey: keyof M,
	otherKey: keyof M,
	params?: TParams,
): string {
	return t(count === 1 ? oneKey : otherKey, { count, ...params });
}

/**
 * The source (base) UI language. Every app's inline manifest IS the English
 * catalog; overlay packs (`es`/`de`/…) only carry the keys a locale translates,
 * merged over the manifest by `createT`. Mirrors the shell's
 * `shared/locale-catalog.ts` constant — that file now re-exports this one so the
 * value has a single home shared by shell + apps (12.15 slice 15c).
 */
export const SOURCE_LANGUAGE = "en";

/**
 * Resolve the fallback chain for a requested BCP-47 tag, ending at the source
 * language. e.g. `"de-AT"` → `["de-AT", "de", "en"]`. A loader walks this and
 * uses the first overlay that exists; `t()` then resolves per-key with English
 * as the ultimate backstop (untranslated keys show their manifest value, never a
 * key string). Pure + exported for unit tests.
 */
export function localeFallbackChain(tag: string): string[] {
	const chain: string[] = [];
	const parts = tag.split("-");
	for (let i = parts.length; i > 0; i -= 1) {
		const candidate = parts.slice(0, i).join("-");
		if (candidate && !chain.includes(candidate)) chain.push(candidate);
	}
	if (!chain.includes(SOURCE_LANGUAGE)) chain.push(SOURCE_LANGUAGE);
	return chain;
}

/** A lazy importer for one locale's overlay pack — `() => import("./i18n/de.json")`.
 *  The default export is a `Partial<M>` of just the keys that locale translates. */
export type LocalePackImporter<M extends Record<string, string>> = () => Promise<{
	default: Partial<M>;
}>;

/** Per-locale lazy importers, keyed by BCP-47 tag. The source language needs no
 *  entry (English is the inline manifest). Static keys let the bundler code-split
 *  each pack, so untranslated apps add zero cold-bundle weight. */
export type LocalePackImporters<M extends Record<string, string>> = Partial<
	Record<string, LocalePackImporter<M>>
>;

/**
 * Resolve the overlay pack for `activeLocale` from an app's lazy importers.
 * Walks the fallback chain and loads the first pack that exists, stopping at the
 * source language (English ⇒ no overlay ⇒ `null`). A failed import is logged and
 * skipped (the chain continues; English is the backstop), so a broken pack never
 * throws into render. The 15b `useLocalePackT` hook feeds the result to
 * `createT` as the overlay.
 */
export async function resolveLocalePack<M extends Record<string, string>>(
	activeLocale: string,
	importers: LocalePackImporters<M>,
): Promise<Partial<M> | null> {
	for (const candidate of localeFallbackChain(activeLocale)) {
		if (candidate === SOURCE_LANGUAGE) return null;
		const importer = importers[candidate];
		if (!importer) continue;
		try {
			const pack = await importer();
			return pack.default;
		} catch (error) {
			console.warn(`[i18n] failed to load locale pack "${candidate}"`, error);
		}
	}
	return null;
}
