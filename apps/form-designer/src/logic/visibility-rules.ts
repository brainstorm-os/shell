/**
 * Conditional cell visibility for Fill mode (8.10.4).
 *
 * A form field may carry an optional `condition` (a `PropertyPredicate`
 * on the field, persisted on the layout cell's canonical `condition`).
 * In Fill mode the field shows only when that predicate holds against
 * the in-progress values — and a hidden field is excluded from both the
 * required-value validation (it can't block Create) and the written
 * `properties` (a hidden answer is never persisted).
 *
 * The predicate is evaluated by the SHARED `@brainstorm-os/sdk/predicate-eval`
 * stack — the exact evaluator the Database filter language + ListSource
 * membership run — so visibility rules speak one language, never a
 * second form-only mini-language. The in-progress values stand in for
 * the entity's `properties`.
 *
 * Pure — no DOM. Lives beside `form-model` so it gets node-env coverage.
 */

import type { PropertyPredicate } from "@brainstorm-os/sdk-types";
import type { EntityRow } from "@brainstorm-os/sdk/in-memory-entities";
import { evaluatePredicate } from "@brainstorm-os/sdk/predicate-eval";
import { type FormField, emptyFillFields, fillValuesToProperties } from "./form-model";

/** Treat the collected fill values as a single entity's `properties` so
 *  the shared predicate evaluator can read them by key. The non-property
 *  fields are inert stubs — predicates only ever read `properties`. */
function valuesToRow(values: Readonly<Record<string, unknown>>): EntityRow {
	return {
		id: "",
		type: "",
		properties: { ...values },
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
	};
}

/** Whether a condition holds against the current values. An absent
 *  condition is always visible. `now` is forwarded to the evaluator so a
 *  `$relativeDate` rule rolls against one consistent clock (and tests can
 *  pin it); omitted ⇒ the evaluator's own `Date.now()`. */
export function isConditionMet(
	condition: PropertyPredicate | undefined,
	values: Readonly<Record<string, unknown>>,
	now?: number,
): boolean {
	if (!condition) return true;
	return evaluatePredicate(valuesToRow(values), condition, now);
}

/** Whether a field is shown given the current values. */
export function isFieldVisible(
	field: FormField,
	values: Readonly<Record<string, unknown>>,
	now?: number,
): boolean {
	return isConditionMet(field.condition, values, now);
}

/** The fields currently shown, in document order. */
export function visibleFields(
	fields: readonly FormField[],
	values: Readonly<Record<string, unknown>>,
	now?: number,
): FormField[] {
	return fields.filter((field) => isFieldVisible(field, values, now));
}

/** Empty *required* fields that must block Create — the empty set of the
 *  currently-VISIBLE fields only, so a hidden field never blocks the form
 *  (F-239 validation restricted to what the user can actually see). */
export function requiredEmptyFields(
	fields: readonly FormField[],
	values: Readonly<Record<string, unknown>>,
	now?: number,
): FormField[] {
	return emptyFillFields({ fields: visibleFields(fields, values, now), values });
}

/** Map collected values to the new entity's `properties`, dropping any
 *  hidden field's value so a conditionally-hidden answer is never
 *  persisted (the visible-field projection of `fillValuesToProperties`). */
export function visibleFillProperties(
	input: {
		fields: readonly FormField[];
		values: Readonly<Record<string, unknown>>;
		fallbackName: string;
	},
	now?: number,
): Record<string, unknown> {
	return fillValuesToProperties({
		fields: visibleFields(input.fields, input.values, now),
		values: input.values,
		fallbackName: input.fallbackName,
	});
}
