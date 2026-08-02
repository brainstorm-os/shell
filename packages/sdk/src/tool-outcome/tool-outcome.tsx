/**
 * Named refusal chips for a tool call (Tool-8b, doc 78).
 *
 * `tools.call` refuses with NAMED errors — `Denied`, `NeedsConfirm`, `Busy`,
 * `TooLarge`, `Timeout`, `ProviderError`, `Invalid`, `Unavailable` — and every
 * surface that runs a tool is required to report the outcome, because a
 * swallowed refusal is a control that silently does nothing. Doc 78 states the
 * bar directly: **a hung spinner is the bug.**
 *
 * There is no toast API in the SDK (toasts are shell-renderer only), so before
 * this every app had to invent its own reporter, and the required seam was
 * easy to leave unfilled — which is exactly what the `Tool-7` review found.
 * This is the drop-in: a hook that collects outcomes and a component that
 * renders them, so an app satisfies the contract with two lines.
 *
 * The provider's own error text is rendered as DATA and never interpreted; it
 * arrives already clamped to 500 characters by `AppCallHost`.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** How long a chip stays before it retires itself. Long enough to read a
 *  refusal, short enough not to become furniture. A FAILURE stays until
 *  dismissed — the one outcome a user may need to act on. */
export const TOOL_OUTCOME_TTL_MS = 6_000;

/** What a caller reports. A DISCRIMINATED union — `Omit<ToolOutcome, "id">`
 *  looks equivalent but is not: `Omit` over a union collapses it to the common
 *  keys, so the failure variant's `kind`/`message` stop being assignable. */
export type ToolOutcomeInput =
	| { ok: true; title: string }
	| { ok: false; title: string; kind: string; message: string };

export type ToolOutcome = ToolOutcomeInput & { id: string };

/** Every refusal `tools.call` can produce, mapped to the key a host
 *  translates. Exhaustive on purpose: an unmapped kind falls back to the
 *  generic key rather than rendering a raw error name at the user. */
export const TOOL_REFUSAL_KEYS: Readonly<Record<string, string>> = {
	Denied: "tool.refused.denied",
	NeedsConfirm: "tool.refused.needsConfirm",
	Busy: "tool.refused.busy",
	TooLarge: "tool.refused.tooLarge",
	Timeout: "tool.refused.timeout",
	ProviderError: "tool.refused.provider",
	Invalid: "tool.refused.invalid",
	Unavailable: "tool.refused.unavailable",
};

export function refusalKeyFor(kind: string): string {
	return TOOL_REFUSAL_KEYS[kind] ?? "tool.refused.generic";
}

let seq = 0;

/** Collect tool outcomes for rendering. The returned `report` is the exact
 *  shape every tool surface asks for, so an app wires it straight through. */
export function useToolOutcomes(): {
	outcomes: readonly ToolOutcome[];
	report: (outcome: ToolOutcomeInput) => void;
	dismiss: (id: string) => void;
} {
	const [outcomes, setOutcomes] = useState<readonly ToolOutcome[]>([]);
	const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

	const dismiss = useCallback((id: string) => {
		const timer = timers.current.get(id);
		if (timer) clearTimeout(timer);
		timers.current.delete(id);
		setOutcomes((prev) => prev.filter((o) => o.id !== id));
	}, []);

	const report = useCallback(
		(outcome: ToolOutcomeInput) => {
			seq += 1;
			const id = `tool-outcome-${seq}`;
			setOutcomes((prev) => [...prev, { ...outcome, id }]);
			// Successes retire themselves; a refusal waits to be dismissed, since
			// it is the outcome a user may still need to act on.
			if (outcome.ok) {
				timers.current.set(
					id,
					setTimeout(() => dismiss(id), TOOL_OUTCOME_TTL_MS),
				);
			}
		},
		[dismiss],
	);

	// Timers outlive the component otherwise — a dismissed app would still be
	// scheduling setState on an unmounted tree.
	const timerMap = timers.current;
	useEffect(() => {
		return () => {
			for (const timer of timerMap.values()) clearTimeout(timer);
			timerMap.clear();
		};
	}, [timerMap]);

	return { outcomes, report, dismiss };
}

export type ToolOutcomeChipsProps = {
	outcomes: readonly ToolOutcome[];
	onDismiss: (id: string) => void;
	/** Translate a key. Apps pass their own `t`; the SDK never ships copy. */
	t: (key: string, params?: Record<string, string | number>) => string;
};

export function ToolOutcomeChips({ outcomes, onDismiss, t }: ToolOutcomeChipsProps) {
	if (outcomes.length === 0) return null;
	return (
		// `polite`, not `assertive`: a tool result is worth announcing, not worth
		// interrupting whatever the screen reader is already saying.
		<div className="bs-tool-outcomes" role="status" aria-live="polite">
			{outcomes.map((outcome) => (
				<div
					key={outcome.id}
					className={
						outcome.ok
							? "bs-tool-outcome bs-tool-outcome--ok"
							: "bs-tool-outcome bs-tool-outcome--refused"
					}
				>
					<span className="bs-tool-outcome__title">{outcome.title}</span>
					{!outcome.ok && (
						<span className="bs-tool-outcome__reason">{t(refusalKeyFor(outcome.kind))}</span>
					)}
					<button
						type="button"
						className="bs-tool-outcome__dismiss"
						onClick={() => onDismiss(outcome.id)}
						aria-label={t("tool.outcome.dismiss")}
					>
						×
					</button>
				</div>
			))}
		</div>
	);
}
