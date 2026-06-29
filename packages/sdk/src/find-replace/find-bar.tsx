/**
 * `<FindBar>` — the shared, identical-everywhere in-document find &
 * replace bar (the React twin; `attachFindBar` is the vanilla-DOM one).
 * Driven entirely off a `FindController`; chrome (`.bs-find-bar*`) is
 * owned by the shell-injected stylesheet so it looks the same in every
 * text app (the `<NavButtons>` precedent — apps declare zero styling).
 *
 * a11y (doc 59): the bar is a labelled `role="search"`; the match
 * counter is `aria-live="polite"` so a screen-reader hears "3 of 17" as
 * the user steps matches. Closed ⇒ unmounted (focus returns to the
 * document by the host).
 */

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { DEFAULT_FIND_LABELS, type FindLabels } from "../i18n/common-labels";
import { Icon, IconDirection, IconName } from "../icon";
import { type FindController, FindStatus } from "./find-controller";

export type FindBarProps = {
	controller: FindController;
	/** `find-replace` reveals the replace row; `find` is search-only. */
	mode?: "find" | "find-replace";
	labels?: Partial<FindLabels>;
	className?: string;
};

function fill(template: string, vars: Record<string, string | number>): string {
	return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

export function FindBar({ controller, mode = "find", labels, className }: FindBarProps) {
	const merged: FindLabels = { ...DEFAULT_FIND_LABELS, ...labels };
	const state = useSyncExternalStore(
		(cb) => controller.subscribe(cb),
		() => controller.getState(),
		() => controller.getState(),
	);
	const [replacement, setReplacement] = useState("");
	const termRef = useRef<HTMLInputElement>(null);
	const counterId = useId();

	// Focus the term input when the bar opens (the host opens via a
	// chord; the bar owns where focus lands), without stealing focus on
	// every keystroke-driven re-render. Select the retained term so a
	// reopen lets typing replace it while bare Enter still reuses it
	// (the standard editor/browser find behavior — F-214).
	const wasOpen = useRef(false);
	useEffect(() => {
		if (state.open && !wasOpen.current) {
			termRef.current?.focus();
			termRef.current?.select();
		}
		wasOpen.current = state.open;
	}, [state.open]);

	if (!state.open) return null;

	const counter =
		state.status === FindStatus.NoMatches
			? merged.noResults
			: state.status === FindStatus.Matches
				? fill(merged.matchCount, {
						current: state.activeIndex + 1,
						total: state.matchCount,
					})
				: "";
	const hasMatches = state.matchCount > 0;

	const toggle = (key: keyof typeof state.options) =>
		controller.setOptions({ [key]: !state.options[key] });

	return (
		<div
			className={className ? `bs-find-bar ${className}` : "bs-find-bar"}
			role="search"
			aria-label={merged.region}
		>
			<div className="bs-find-bar__row">
				<input
					ref={termRef}
					type="text"
					className="bs-find-bar__input"
					data-testid="find-term"
					aria-label={merged.term}
					placeholder={merged.term}
					value={state.term}
					aria-describedby={counterId}
					onChange={(e) => controller.setTerm(e.target.value)}
					// keyboard-exempt: input-local — Enter steps matches (Shift = previous),
					// Escape closes the find bar; scoped to the find input the user is typing
					// in (the DOM twin `attach-find-bar` binds Escape via `attachShortcut`).
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							e.shiftKey ? controller.previous() : controller.next();
						} else if (e.key === "Escape") {
							e.preventDefault();
							controller.close();
						}
					}}
				/>
				<span id={counterId} className="bs-find-bar__count" data-testid="find-count" aria-live="polite">
					{counter}
				</span>
				<button
					type="button"
					className="bs-find-bar__btn"
					data-testid="find-prev"
					aria-label={merged.previous}
					data-bs-tooltip={merged.previous}
					title={hasMatches ? undefined : merged.previous}
					disabled={!hasMatches}
					onClick={() => controller.previous()}
				>
					<Icon name={IconName.CaretLeft} size={15} direction={IconDirection.Inline} />
				</button>
				<button
					type="button"
					className="bs-find-bar__btn"
					data-testid="find-next"
					aria-label={merged.next}
					data-bs-tooltip={merged.next}
					title={hasMatches ? undefined : merged.next}
					disabled={!hasMatches}
					onClick={() => controller.next()}
				>
					<Icon name={IconName.CaretRight} size={15} direction={IconDirection.Inline} />
				</button>
				{(
					[
						["caseSensitive", "Aa", merged.caseSensitive],
						["wholeWord", "Ab", merged.wholeWord],
						["regex", ".*", merged.regex],
						["inSelection", "Sel", merged.inSelection],
					] as const
				).map(([key, marker, label]) => (
					<button
						key={key}
						type="button"
						className="bs-find-bar__toggle"
						data-testid={`find-opt-${key}`}
						aria-pressed={state.options[key]}
						aria-label={label}
						title={label}
						onClick={() => toggle(key)}
					>
						{marker}
					</button>
				))}
				<button
					type="button"
					className="bs-find-bar__btn"
					data-testid="find-close"
					aria-label={merged.close}
					data-bs-tooltip={merged.close}
					onClick={() => controller.close()}
				>
					<Icon name={IconName.Close} size={15} />
				</button>
			</div>
			{mode === "find-replace" && (
				<div className="bs-find-bar__row bs-find-bar__row--replace">
					<input
						type="text"
						className="bs-find-bar__input"
						data-testid="find-replacement"
						aria-label={merged.replacement}
						placeholder={merged.replacement}
						value={replacement}
						onChange={(e) => setReplacement(e.target.value)}
					/>
					<button
						type="button"
						className="bs-find-bar__action"
						data-testid="find-replace"
						disabled={!hasMatches}
						onClick={() => controller.replace(replacement)}
					>
						{merged.replace}
					</button>
					<button
						type="button"
						className="bs-find-bar__action"
						data-testid="find-replace-all"
						disabled={!hasMatches}
						onClick={() => controller.replaceAll(replacement)}
					>
						{merged.replaceAll}
					</button>
				</div>
			)}
		</div>
	);
}
