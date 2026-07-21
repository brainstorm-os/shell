/**
 * `defForPreset(preset, opts)` — Settings constructor helper.
 *
 * Picks the right `(valueType + modifiers)` tuple for the user-facing
 * "kind preset" they selected (Text / Number / Select / URL / File /
 * etc.) and assembles a fresh `PropertyDef` ready to write to the
 * vault PropertyStore.
 *
 * Centralised so the Settings → Data form, the AddPropertyMenu's
 * "+ Create new property" entry (when B5.6 wires it), and any future
 * "preset → def" call site share one canonical mapping.
 */

import {
	type Cardinality,
	FILE_ENTITY_TYPE,
	type Icon,
	PRESET_DEFAULTS,
	type PropertyDef,
	PropertyKindPreset,
	ValueType,
	type VocabularyRef,
} from "@brainstorm-os/sdk-types";

export type DefForPresetOptions = {
	name: string;
	icon?: Icon | null;
	description?: string;
	/** Required when the preset is `Select` or `MultiSelect`. Other
	 *  presets ignore. */
	vocabulary?: VocabularyRef;
	/** Override the default cardinality (rarely needed — `Select` /
	 *  `MultiSelect` already pick the spec defaults). */
	count?: Cardinality;
	/** Override `allowedTypes` for `Link` (the `File` preset always
	 *  pins to `brainstorm/File/v1`). */
	allowedTypes?: readonly string[];
	/** Stable property key. The caller (Settings UI / +Create flow)
	 *  typically passes the `newPropertyKey()` result. */
	key: string;
};

/**
 * Build a freshly-minted PropertyDef matching `preset`. Throws if the
 * preset requires a vocabulary and none is supplied — the caller's UI
 * must surface a vocabulary picker before calling.
 */
export function defForPreset(preset: PropertyKindPreset, opts: DefForPresetOptions): PropertyDef {
	const defaults = PRESET_DEFAULTS[preset];
	const base: PropertyDef = {
		key: opts.key,
		name: opts.name.trim(),
		icon: opts.icon ?? null,
		valueType: defaults.valueType,
	};
	if (opts.description !== undefined) {
		base.description = opts.description;
	}
	if (opts.count !== undefined) {
		base.count = opts.count;
	} else if (defaults.count !== undefined) {
		base.count = defaults.count;
	}
	if (defaults.format !== undefined) {
		base.format = defaults.format;
	}
	if (defaults.allowedTypes !== undefined) {
		base.allowedTypes = defaults.allowedTypes;
	} else if (opts.allowedTypes !== undefined) {
		base.allowedTypes = opts.allowedTypes;
	}
	if (defaults.requiresVocabulary) {
		if (!opts.vocabulary) {
			throw new Error(
				`defForPreset: preset ${preset} requires a vocabulary; pass { vocabulary: { dictionaryId } }`,
			);
		}
		base.vocabulary = opts.vocabulary;
	}
	return base;
}

/** Convenience accessor for callers that only need the File entity
 *  type literal. Re-exported here so the Settings UI doesn't import
 *  from `sdk-types` directly when it doesn't need anything else. */
export { FILE_ENTITY_TYPE, PropertyKindPreset, ValueType };
