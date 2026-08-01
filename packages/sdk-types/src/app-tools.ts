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
};

/** The registered form: the declaration plus its owning app and full id. */
export type AppToolRecord = AppToolRegistration & {
	/** `app.<appId>.<name>`. */
	id: string;
	appId: string;
	registeredAt: number;
};

/** Build a tool's globally-unique id. */
export function appToolId(appId: string, name: string): string {
	return `app.${appId}.${name}`;
}

/** Names an app tool may never claim — the curated intent verbs. A tool must
 *  not impersonate the routing layer (intents route: "somebody handle this";
 *  tools call: "this app compute this"). */
export const RESERVED_APP_TOOL_NAMES: ReadonlySet<string> = new Set([
	"open",
	"share",
	"insert",
	"export",
	"process",
	"import",
	"compose",
	"send",
	"reply",
	"forward",
]);

/** Control characters are REFUSED, never silently stripped: a descriptor
 *  carrying them is malformed, and a partial strip could still smuggle prompt
 *  structure past a reviewer's eye. Covers C0, DEL, and the bidi/zero-width
 *  overrides that render invisibly. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

export type AppToolValidation = { ok: true } | { ok: false; reason: string; field: string };

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
	if (t.title.length > APP_TOOL_TITLE_MAX || CONTROL_CHARS.test(t.title)) {
		return {
			ok: false,
			reason: `tool.title must be <= ${APP_TOOL_TITLE_MAX} chars with no control characters`,
			field: "title",
		};
	}
	if (typeof t.description !== "string" || t.description.trim().length === 0) {
		return { ok: false, reason: "tool.description required", field: "description" };
	}
	if (t.description.length > APP_TOOL_DESCRIPTION_MAX || CONTROL_CHARS.test(t.description)) {
		return {
			ok: false,
			reason: `tool.description must be <= ${APP_TOOL_DESCRIPTION_MAX} chars with no control characters`,
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

/** Normalize a validated declaration (defaults applied). */
export function normalizeAppTool(value: AppToolRegistration): AppToolRegistration {
	return {
		name: value.name,
		title: value.title,
		description: value.description,
		effect: value.effect,
		appliesTo: value.appliesTo ?? [],
		surfaces: value.surfaces ?? [],
	};
}

/** Does `tool` apply to an object of `entityType`? Declared-types-only match
 *  (never content). An empty `appliesTo` means "any object". */
export function appToolApplies(tool: AppToolRegistration, entityType: string | null): boolean {
	if (tool.appliesTo.length === 0) return true;
	if (entityType === null) return false;
	return tool.appliesTo.includes(entityType);
}
