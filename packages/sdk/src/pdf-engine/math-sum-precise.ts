/**
 * `Math.sumPrecise` polyfill for Chromium < 137 (Electron 41 ships ~134).
 *
 * pdf.js v6 calls `Math.sumPrecise` in both the main thread and its worker. On
 * a runtime without it the call throws `TypeError: Math.sumPrecise is not a
 * function` and aborts the affected render path (seen as a Books/Preview PDF
 * failing to paint). The worker has its own realm, so a main-thread install
 * does not reach it — `installMathSumPrecise()` must run in each.
 *
 * The TC39 proposal specifies a correctly-rounded sum; pdf.js only needs an
 * accurate one, so this uses Neumaier (Kahan–Babuška) compensated summation —
 * far better than naive `+` and sufficient for the layout/geometry math pdf.js
 * uses it for. The edge cases pdf.js can hit match the spec surface: a
 * non-iterable argument or a non-Number element throws `TypeError`; an empty
 * iterable returns `-0`; `NaN` / `±Infinity` propagate.
 */
export function mathSumPrecise(values: Iterable<number>): number {
	const iterator = (values as { [Symbol.iterator]?: unknown } | null)?.[Symbol.iterator];
	if (typeof iterator !== "function") {
		throw new TypeError("Math.sumPrecise requires an iterable");
	}

	let sum = 0;
	let compensation = 0;
	let naive = 0;
	let count = 0;
	let allFinite = true;
	for (const value of values) {
		if (typeof value !== "number") {
			throw new TypeError("Math.sumPrecise: all values must be numbers");
		}
		count += 1;
		naive += value;
		if (!Number.isFinite(value)) allFinite = false;
		const next = sum + value;
		compensation += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
		sum = next;
	}
	if (count === 0) return -0;
	// Compensation arithmetic is only valid over finite terms; a NaN/±Infinity
	// term (or a finite run that overflows mid-accumulation) makes it produce a
	// spurious NaN. Fall back to plain IEEE accumulation, which yields the
	// correct non-finite result.
	if (!allFinite) return naive;
	const result = sum + compensation;
	return Number.isFinite(result) ? result : naive;
}

/**
 * Install the polyfill onto the current realm's `Math` when absent. Idempotent
 * and realm-scoped — call it on the main thread AND inside the pdf worker.
 */
export function installMathSumPrecise(): void {
	const math = Math as unknown as { sumPrecise?: (values: Iterable<number>) => number };
	if (typeof math.sumPrecise !== "function") {
		math.sumPrecise = mathSumPrecise;
	}
}
