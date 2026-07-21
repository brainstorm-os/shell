/**
 * FormulaCell — a read-only computed value (number + format=formula). Compiles
 * the property's expression (`PropertyDef.formula`, e.g. `{qty} * {rate}`) once
 * and evaluates it against the entity's OTHER property values (`props.siblings`,
 * supplied by entity-rendering hosts: the Database grid + object inspectors).
 *
 * Never editable. A compile / evaluation error (bad syntax, a non-numeric
 * reference, divide by zero) renders as a muted `⚠` chip carrying the message as
 * a tooltip — never a throw, never a blank that hides the mistake. Missing
 * sibling context (a host that renders a value in isolation) renders an em-dash.
 */

import { type CellProps, ValueType } from "@brainstorm-os/sdk-types";
import { compileFormula } from "@brainstorm-os/sdk/formula";
import type { JSX } from "react";
import { useMemo } from "react";
import { formatScalar } from "./format";

export function FormulaCell(props: CellProps): JSX.Element {
	const { property, siblings } = props;
	const expression = property.formula ?? "";

	const compiled = useMemo(() => compileFormula(expression), [expression]);

	if (!compiled.ok) {
		return (
			<span className="bs-cell-formula bs-cell-formula--error" title={compiled.error}>
				⚠
			</span>
		);
	}

	if (!siblings) {
		return <span className="bs-cell-formula bs-cell-formula--empty">—</span>;
	}

	const result = compiled.formula.evaluate((key) => siblings[key]);
	if (!result.ok) {
		return (
			<span className="bs-cell-formula bs-cell-formula--error" title={result.error}>
				⚠
			</span>
		);
	}

	// Reuse the number formatter (respects `precision`); format=formula falls to
	// the plain-number branch, so the computed result renders as a clean number.
	const display = formatScalar({ ...property, valueType: ValueType.Number }, result.value as never);
	return <span className="bs-cell-formula">{display}</span>;
}
