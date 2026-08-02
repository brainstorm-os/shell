/**
 * App tools — the shared contract (Tool-2, doc 78).
 *
 * An installed app declares tools in its manifest; the shell registers them
 * and offers them to other apps' menus, the agent's Tools layer, and
 * automation steps. Ids are `app.<appId>.<toolName>`, deliberately mirroring
 * `mcp.<serverId>.<toolName>` so one addressing scheme covers both provider
 * kinds.
 *
 * SECURITY (doc 78 §Security): a tool's `title` / `description` is UNTRUSTED
 * TEXT THAT REACHES THE MODEL — a sideloaded app authoring `description` is
 * authoring part of the agent's prompt. The mitigations MCP descriptors get
 * are reused wholesale: length caps, control-character rejection, and (later
 * rungs) quarantined rendering plus the rug-pull re-prompt.
 *
 * `effect` LOWERS FRICTION BUT IS NEVER A SECURITY BOUNDARY — the capability
 * check is (doc 78, mirroring MCP's `readOnlyHint`).
 */

import {
	CARDINALITY_HARD_MAX,
	type Cardinality,
	DateGranularity,
	PropertyFormat,
	type Range,
	ValueType,
} from "./properties";

/** Declared side-effect class. Friction follows from it; authority does not. */
export enum AppToolEffect {
	/** No vault read, no side effects — may auto-run. */
	Pure = "pure",
	/** Reads vault data — rides the existing capability paths. */
	ReadsVault = "reads-vault",
	/** Talks to the network — rides the existing egress paths. */
	External = "external",
	/** Returns a proposal the caller renders and a human approves. NEVER
	 *  persists on its own (doc 75 / OQ-ANS-4, generalized from the agent to
	 *  every app). */
	ProposesWrite = "proposes-write",
}

/** Where a tool may be offered. A tool with no surfaces is registered but
 *  never presented — useful for agent-only tools. */
export enum AppToolSurface {
	/** Object / selection menus in other apps. */
	Menu = "menu",
	/** The agent's Tools layer. */
	Agent = "agent",
	/** Automation steps. */
	Automation = "automation",
}

/** Name grammar: lowercase, dot-free (the dot separates the id's segments),
 *  so `app.<appId>.<toolName>` parses unambiguously. */
export const APP_TOOL_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
export const APP_TOOL_TITLE_MAX = 128;
export const APP_TOOL_DESCRIPTION_MAX = 4_096;
/** Per-app ceiling — a runaway manifest can't flood a menu or the agent's
 *  tool surface (mirrors `MCP_TOOLS_PER_SERVER_MAX`). */
export const APP_TOOLS_PER_APP_MAX = 32;

// ─── Typed arguments (Tool-3, OQ-TOOL-1 resolved: PropertyDef, not JSON Schema)

/** Argument-key grammar. `camelCase`-friendly (unlike the tool name, which is
 *  an ADDRESS segment and so stays dot-free lowercase) because these are
 *  object keys the model writes. */
export const APP_TOOL_INPUT_NAME_RE = /^[a-z][a-zA-Z0-9_]{0,31}$/;
export const APP_TOOL_INPUTS_MAX = 16;
/** An input's description reaches the model exactly as the tool's does — same
 *  untrusted-text treatment, a tighter cap (it is a one-liner, not prose). */
export const APP_TOOL_INPUT_DESCRIPTION_MAX = 512;
/** Ceiling on a `choices` list — a closed set a model picks from, not a
 *  dictionary. */
export const APP_TOOL_INPUT_CHOICES_MAX = 64;
/** `pattern` and `allowedTypes` entries are projected verbatim into the
 *  model's schema, so they are length-capped and invisible-text-screened like
 *  the prose fields. */
export const APP_TOOL_INPUT_PATTERN_MAX = 512;
export const APP_TOOL_INPUT_TYPE_NAME_MAX = 128;

/** One declared argument.
 *
 * OQ-TOOL-1 resolved to **`PropertyDef`, not raw JSON Schema**: this adopts
 * PropertyDef's *value-type system and its real validator*, which is the whole
 * point — `validateAppToolArgs` builds a genuine `PropertyDef` and runs
 * `validateValue` **at the broker, before the call reaches the providing app**.
 * It deliberately does NOT adopt PropertyDef's record shape: `key` / `icon` /
 * `display` / `unique` / `formula` describe a stored column, and an argument is
 * a value in flight.
 *
 * Two arity knobs, no overlap (they mirror JSON Schema's `required` +
 * `minItems`/`maxItems`): `required` governs whether the KEY must be present;
 * `count` governs how many items the value may hold once it is.
 */
export type AppToolInput = {
	name: string;
	/** UNTRUSTED TEXT THAT REACHES THE MODEL — see this file's header. */
	description: string;
	required: boolean;
	/** `richText` is REFUSED: its `validateValue` arm is a deliberate no-op
	 *  (a `Y.XmlFragment` is opaque at that layer), so allowing it would mean
	 *  one value type that crosses the broker entirely unchecked. */
	valueType: Exclude<ValueType, ValueType.RichText>;
	/** Multi-valued when `max > 1`. The wire value is then a PLAIN array of
	 *  scalars — NOT the `LabeledValue` envelope a stored multi-value property
	 *  uses, because an argument has no per-value display labels. */
	count?: Cardinality;
	format?: PropertyFormat;
	/** Anchored whole-string on validation; `text` only. */
	pattern?: string;
	/** `number` only. Enforced here — `validateValue` does not check it. */
	range?: Range;
	/** `date` only. */
	granularity?: DateGranularity;
	/** `entityRef` only; empty/absent means any type. */
	allowedTypes?: readonly string[];
	/** Closed choice set; `text` only. The tool-argument analogue of
	 *  PropertyDef's `vocabulary`, without the dictionary indirection — a
	 *  dictionary id would need resolving mid-validation, and an argument's
	 *  choices are a property of the tool, not of the vault. */
	choices?: readonly string[];
};

/** One declared tool, as it lives in the manifest and the registry. */
export type AppToolRegistration = {
	name: string;
	title: string;
	description: string;
	effect: AppToolEffect;
	/** Entity types this tool applies to (empty = any). Matched on DECLARED
	 *  types only — applicability must never read content (doc 78
	 *  §Performance budgets: `tools.list` is a registry read on menu open). */
	appliesTo: readonly string[];
	surfaces: readonly AppToolSurface[];
	/** Declared arguments (Tool-3). Empty = the tool takes none. */
	input: readonly AppToolInput[];
};

/** The registered form: the declaration plus its owning app and full id. */
export type AppToolRecord = AppToolRegistration & {
	/** `app.<appId>.<name>`. */
	id: string;
	appId: string;
	registeredAt: number;
	/** Set when the PERSISTED declaration failed to re-validate on read (a
	 *  corrupt or hand-edited registry row). Such a tool is never offered and
	 *  never callable. It is an explicit flag rather than an inference from an
	 *  empty `surfaces`, so the drop is legible at every consumer instead of
	 *  each one re-deriving it — and so a tool fetched by id for DISPATCH is
	 *  refused too, not just one that fails to appear in a listing. */
	declarationInvalid?: true;
};

/** Build a tool's globally-unique id. */
export function appToolId(appId: string, name: string): string {
	return `app.${appId}.${name}`;
}

/** Names an app tool may never claim — the curated intent verbs. A tool must
 *  not impersonate the routing layer (intents route: "somebody handle this";
 *  tools call: "this app compute this"). */
export const CURATED_INTENT_VERBS = [
	"open",
	"insert",
	"share",
	"convert",
	"export",
	"import",
	"process",
	"compose",
	"quick-look",
	"move",
	"send",
	"reply",
	"forward",
] as const;

export const RESERVED_APP_TOOL_NAMES: ReadonlySet<string> = new Set(CURATED_INTENT_VERBS);

/** Invisible text is REFUSED, never silently stripped: a descriptor carrying
 *  it is malformed, and a partial strip could still smuggle prompt structure
 *  past a reviewer's eye. Covers C0/C1, DEL, soft hyphen, the bidi controls
 *  and isolates, zero-width and word-joiner ranges, BOM/interlinear marks,
 *  variation selectors, and the Unicode **Tags** block (U+E0000–E007F) — the
 *  standard channel for smuggling arbitrary ASCII invisibly into a model
 *  prompt. Blank-rendering-but-not-whitespace characters (Hangul fillers,
 *  Braille blank) are refused separately, since `.trim()` keeps them. */
const INVISIBLE_TEXT =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
	// biome-ignore lint/suspicious/noMisleadingCharacterClass: each variation selector is refused individually, which is the point
	/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb\ufe00-\ufe0f]|[\u{e0000}-\u{e007f}]|[\u{e0100}-\u{e01ef}]/u;

/** Characters that RENDER as nothing but survive `.trim()` — a title made of
 *  these is a clickable menu row with no label. */
const BLANK_RENDERING = /^[\s\u115f\u1160\u2800\u3164\uffa0]*$/u;

export type AppToolValidation = { ok: true } | { ok: false; reason: string; field: string };

/** Which formats a tool argument may carry, per value type. Narrower than
 *  `PropertyDef`'s table on purpose: the numeric *display* formats
 *  (currency/percent/duration) and `formula` describe how a stored value is
 *  RENDERED, which an argument in flight has no notion of. */
const INPUT_FORMATS: Readonly<Record<string, ReadonlySet<PropertyFormat>>> = Object.freeze({
	[ValueType.Text]: new Set<PropertyFormat>([
		PropertyFormat.Email,
		PropertyFormat.Url,
		PropertyFormat.Phone,
		PropertyFormat.Markdown,
		PropertyFormat.Code,
	]),
});

/** A modifier belongs to exactly one value type. Declaring `range` on a text
 *  argument is a manifest bug, and silently ignoring it would mean a provider
 *  believing it had a bound the broker never enforces. */
const INPUT_MODIFIER_VALUE_TYPE: Readonly<Record<string, ValueType>> = Object.freeze({
	pattern: ValueType.Text,
	choices: ValueType.Text,
	range: ValueType.Number,
	granularity: ValueType.Date,
	allowedTypes: ValueType.EntityRef,
});

function fail(reason: string, field: string): AppToolValidation {
	return { ok: false, reason, field };
}

/** Validate one argument declaration. Pure; never throws. `field` is relative
 *  to the tool (`input[2].pattern`). */
export function validateAppToolInput(value: unknown, index: number): AppToolValidation {
	const at = (suffix: string) => `input[${index}]${suffix ? `.${suffix}` : ""}`;
	if (!value || typeof value !== "object") return fail("input must be an object", at(""));
	const i = value as Record<string, unknown>;

	if (typeof i.name !== "string" || !APP_TOOL_INPUT_NAME_RE.test(i.name)) {
		return fail("input.name must match /^[a-z][a-zA-Z0-9_]{0,31}$/", at("name"));
	}
	if (typeof i.description !== "string" || i.description.trim().length === 0) {
		return fail("input.description required", at("description"));
	}
	if (
		i.description.length > APP_TOOL_INPUT_DESCRIPTION_MAX ||
		INVISIBLE_TEXT.test(i.description) ||
		BLANK_RENDERING.test(i.description)
	) {
		return fail(
			`input.description must be <= ${APP_TOOL_INPUT_DESCRIPTION_MAX} visible chars with no invisible/control characters`,
			at("description"),
		);
	}
	if (typeof i.required !== "boolean")
		return fail("input.required must be a boolean", at("required"));

	if (i.valueType === ValueType.RichText) {
		return fail(
			"input.valueType richText is not callable — its value validator is a no-op, so it cannot be checked at the broker",
			at("valueType"),
		);
	}
	if (!KNOWN_INPUT_VALUE_TYPES.has(i.valueType as ValueType)) {
		return fail(
			"input.valueType must be text | number | boolean | date | entityRef",
			at("valueType"),
		);
	}
	const valueType = i.valueType as ValueType;

	// Every declared modifier must belong to this value type.
	for (const [modifier, owner] of Object.entries(INPUT_MODIFIER_VALUE_TYPE)) {
		if (i[modifier] !== undefined && valueType !== owner) {
			return fail(`input.${modifier} is only valid for valueType ${owner}`, at(modifier));
		}
	}

	if (i.count !== undefined) {
		const c = i.count as Partial<Cardinality>;
		if (
			typeof c !== "object" ||
			c === null ||
			!Number.isInteger(c.min) ||
			!Number.isInteger(c.max) ||
			(c.min as number) < 0 ||
			(c.max as number) < 1 ||
			(c.min as number) > (c.max as number) ||
			(c.max as number) > CARDINALITY_HARD_MAX
		) {
			return fail(
				`input.count must be { min, max } integers with 0 <= min <= max <= ${CARDINALITY_HARD_MAX}`,
				at("count"),
			);
		}
	}
	if (i.format !== undefined) {
		const allowed = INPUT_FORMATS[valueType];
		if (!allowed || !allowed.has(i.format as PropertyFormat)) {
			return fail(`input.format is not valid for valueType ${valueType}`, at("format"));
		}
	}
	if (i.pattern !== undefined) {
		// The invisible-text screen applies here too, and this is the BEST hiding
		// place in the whole descriptor: the pattern is projected verbatim into
		// the model's schema, while a human reviewing a manifest reads the field
		// as a regex rather than as prompt text. Tags-block characters are legal
		// regex literals under `u`, so `(?:.*)|<smuggled ASCII>` both compiles and
		// leaves the argument unconstrained.
		if (
			typeof i.pattern !== "string" ||
			i.pattern.length === 0 ||
			i.pattern.length > APP_TOOL_INPUT_PATTERN_MAX ||
			INVISIBLE_TEXT.test(i.pattern)
		) {
			return fail(
				`input.pattern must be a non-empty string of <= ${APP_TOOL_INPUT_PATTERN_MAX} visible chars with no invisible/control characters`,
				at("pattern"),
			);
		}
		try {
			new RegExp(i.pattern, "u");
		} catch {
			return fail("input.pattern must be a valid regular expression", at("pattern"));
		}
	}
	if (i.range !== undefined) {
		const r = i.range as Range;
		const finite = (n: unknown) => n === undefined || (typeof n === "number" && Number.isFinite(n));
		if (
			typeof r !== "object" ||
			r === null ||
			!finite(r.min) ||
			!finite(r.max) ||
			(r.min !== undefined && r.max !== undefined && r.min > r.max)
		) {
			return fail("input.range must be { min?, max? } finite numbers with min <= max", at("range"));
		}
	}
	if (i.granularity !== undefined && !KNOWN_GRANULARITIES.has(i.granularity as DateGranularity)) {
		return fail("input.granularity must be date | datetime | time", at("granularity"));
	}
	if (i.allowedTypes !== undefined) {
		// Also model-facing (the entityRef schema names the allowed types), so
		// also screened.
		if (
			!Array.isArray(i.allowedTypes) ||
			i.allowedTypes.some(
				(x) =>
					typeof x !== "string" ||
					x.length === 0 ||
					x.length > APP_TOOL_INPUT_TYPE_NAME_MAX ||
					INVISIBLE_TEXT.test(x),
			)
		) {
			return fail(
				"input.allowedTypes must be an array of entity types with no invisible/control characters",
				at("allowedTypes"),
			);
		}
	}
	if (i.choices !== undefined) {
		if (
			!Array.isArray(i.choices) ||
			i.choices.length === 0 ||
			i.choices.length > APP_TOOL_INPUT_CHOICES_MAX ||
			i.choices.some(
				(x) =>
					typeof x !== "string" ||
					x.length === 0 ||
					x.length > APP_TOOL_INPUT_TYPE_NAME_MAX ||
					INVISIBLE_TEXT.test(x),
			)
		) {
			return fail(
				`input.choices must be 1..${APP_TOOL_INPUT_CHOICES_MAX} non-empty strings with no invisible characters`,
				at("choices"),
			);
		}
		if (new Set(i.choices as string[]).size !== i.choices.length) {
			return fail("input.choices must not repeat a value", at("choices"));
		}
	}
	return { ok: true };
}

const KNOWN_INPUT_VALUE_TYPES: ReadonlySet<ValueType> = new Set([
	ValueType.Text,
	ValueType.Number,
	ValueType.Boolean,
	ValueType.Date,
	ValueType.EntityRef,
]);

const KNOWN_GRANULARITIES: ReadonlySet<DateGranularity> = new Set(Object.values(DateGranularity));

/** Validate one declaration. Pure; never throws. The caller supplies the
 *  JSONPath-ish prefix for its error message (manifest house style). */
export function validateAppTool(value: unknown): AppToolValidation {
	if (!value || typeof value !== "object") {
		return { ok: false, reason: "tool must be an object", field: "" };
	}
	const t = value as Record<string, unknown>;
	if (typeof t.name !== "string" || !APP_TOOL_NAME_RE.test(t.name)) {
		return {
			ok: false,
			reason: "tool.name must match /^[a-z][a-z0-9-]{0,63}$/ (no dots — the id separator)",
			field: "name",
		};
	}
	if (RESERVED_APP_TOOL_NAMES.has(t.name)) {
		return {
			ok: false,
			reason: `tool.name "${t.name}" collides with a curated intent verb`,
			field: "name",
		};
	}
	if (typeof t.title !== "string" || t.title.trim().length === 0) {
		return { ok: false, reason: "tool.title required", field: "title" };
	}
	if (
		t.title.length > APP_TOOL_TITLE_MAX ||
		INVISIBLE_TEXT.test(t.title) ||
		BLANK_RENDERING.test(t.title)
	) {
		return {
			ok: false,
			reason: `tool.title must be <= ${APP_TOOL_TITLE_MAX} visible chars with no invisible/control characters`,
			field: "title",
		};
	}
	if (typeof t.description !== "string" || t.description.trim().length === 0) {
		return { ok: false, reason: "tool.description required", field: "description" };
	}
	if (
		t.description.length > APP_TOOL_DESCRIPTION_MAX ||
		INVISIBLE_TEXT.test(t.description) ||
		BLANK_RENDERING.test(t.description)
	) {
		return {
			ok: false,
			reason: `tool.description must be <= ${APP_TOOL_DESCRIPTION_MAX} visible chars with no invisible/control characters`,
			field: "description",
		};
	}
	if (!isAppToolEffect(t.effect)) {
		return {
			ok: false,
			reason: "tool.effect must be pure | reads-vault | external | proposes-write",
			field: "effect",
		};
	}
	if (t.appliesTo !== undefined) {
		if (!Array.isArray(t.appliesTo) || t.appliesTo.some((x) => typeof x !== "string" || !x)) {
			return {
				ok: false,
				reason: "tool.appliesTo must be an array of entity types",
				field: "appliesTo",
			};
		}
	}
	if (t.surfaces !== undefined) {
		if (!Array.isArray(t.surfaces) || t.surfaces.some((x) => !isAppToolSurface(x))) {
			return {
				ok: false,
				reason: "tool.surfaces must be an array of menu | agent | automation",
				field: "surfaces",
			};
		}
	}
	if (t.input !== undefined) {
		if (!Array.isArray(t.input)) {
			return { ok: false, reason: "tool.input must be an array", field: "input" };
		}
		if (t.input.length > APP_TOOL_INPUTS_MAX) {
			return {
				ok: false,
				reason: `at most ${APP_TOOL_INPUTS_MAX} inputs per tool`,
				field: "input",
			};
		}
		const seen = new Set<string>();
		for (const [i, arg] of t.input.entries()) {
			const result = validateAppToolInput(arg, i);
			if (!result.ok) return result;
			const name = (arg as AppToolInput).name;
			if (seen.has(name)) {
				return { ok: false, reason: `duplicate input.name "${name}"`, field: `input[${i}].name` };
			}
			seen.add(name);
		}
	}
	return { ok: true };
}

export function isAppToolEffect(value: unknown): value is AppToolEffect {
	return (
		value === AppToolEffect.Pure ||
		value === AppToolEffect.ReadsVault ||
		value === AppToolEffect.External ||
		value === AppToolEffect.ProposesWrite
	);
}

export function isAppToolSurface(value: unknown): value is AppToolSurface {
	return (
		value === AppToolSurface.Menu ||
		value === AppToolSurface.Agent ||
		value === AppToolSurface.Automation
	);
}

/** Normalize a validated declaration (defaults applied). Field-by-field, never
 *  a spread: whatever the manifest carried beyond the contract is DROPPED here
 *  rather than persisted into the registry. */
export function normalizeAppTool(value: AppToolRegistration): AppToolRegistration {
	return {
		name: value.name,
		title: value.title,
		description: value.description,
		effect: value.effect,
		appliesTo: value.appliesTo ?? [],
		surfaces: value.surfaces ?? [],
		input: (value.input ?? []).map(normalizeAppToolInput),
	};
}

export function normalizeAppToolInput(value: AppToolInput): AppToolInput {
	const out: AppToolInput = {
		name: value.name,
		description: value.description,
		required: value.required,
		valueType: value.valueType,
	};
	// `exactOptionalPropertyTypes` — an optional key is either present with a
	// real value or absent; assigning `undefined` is not the same thing.
	if (value.count !== undefined) out.count = value.count;
	if (value.format !== undefined) out.format = value.format;
	if (value.pattern !== undefined) out.pattern = value.pattern;
	if (value.range !== undefined) out.range = value.range;
	if (value.granularity !== undefined) out.granularity = value.granularity;
	if (value.allowedTypes !== undefined) out.allowedTypes = [...value.allowedTypes];
	if (value.choices !== undefined) out.choices = [...value.choices];
	return out;
}

/** Does `tool` apply to an object of `entityType`? Declared-types-only match
 *  (never content). An empty `appliesTo` means "any object". */
export function appToolApplies(tool: AppToolRegistration, entityType: string | null): boolean {
	if (tool.appliesTo.length === 0) return true;
	if (entityType === null) return false;
	return tool.appliesTo.includes(entityType);
}
