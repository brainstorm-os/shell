/**
 * `@brainstorm-os/sdk/picker-host` — the ONE imperative bridge for mounting
 * the shared React pickers inside an otherwise plain-DOM app.
 *
 * Most first-party apps are imperative DOM; the icon/cover pickers are
 * React (doc 13: React is the sanctioned app stack for shared SDK UI).
 * Rather than each app re-implementing a `react-dom/client` root + a
 * body-level container + hardcoded English labels (the old per-app
 * `ui/picker-host.tsx`), this is the single shared helper: one lazily
 * created container, one persistent root, a picker rendered on demand
 * and unmounted on close so there is never a stale overlay.
 *
 * Labels default to the canonical `@brainstorm-os/sdk/i18n` set; a
 * localised app passes a `Partial<…Labels>` of just the keys it
 * translates. React apps should use `<IconPicker>` / `<CoverPicker>`
 * directly inside their own tree instead of this bridge.
 */

import type { Cover, Icon } from "@brainstorm-os/sdk-types";
import {
	CoverPicker,
	type CoverPickerLabels,
	type CoverPickerService,
} from "@brainstorm-os/sdk/cover-picker";
import { createEntityIconElement } from "@brainstorm-os/sdk/entity-icon";
import { IconPicker, type IconPickerLabels } from "@brainstorm-os/sdk/icon-picker";
import { type ReactNode, useEffect, useRef } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
	InlinePropertyForm,
	type InlinePropertyFormCommit,
	type InlinePropertyFormLabels,
} from "./inline-property-form";
import type { RelationTargetType } from "./inline-property-form-logic";

let container: HTMLElement | null = null;
let root: Root | null = null;

function ensureRoot(): Root {
	if (!container) {
		container = document.createElement("div");
		container.className = "bs-picker-host";
		document.body.appendChild(container);
	}
	if (!root) root = createRoot(container);
	return root;
}

/** Unmount whatever picker is open (the picker's own close affordance
 *  and backdrop call this through `onClose`). */
export function closePicker(): void {
	root?.render(null);
}

/** Escape dismisses any picker mounted by this host — keyboard parity with
 *  the backdrop click, for every picker the host opens.
 *  keyboard-exempt: the shared a11y escape-stack is drained only by the shell
 *  dashboard's `installEscapeHandler`; these pickers also mount in sandboxed
 *  app renderers where that handler is absent, so a self-contained
 *  capture-phase listener is the only thing that fires here. */
function useEscapeCapture(onEscape: () => void): void {
	const ref = useRef(onEscape);
	ref.current = onEscape;
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			event.stopPropagation();
			ref.current();
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, []);
}

/** Wraps a host-mounted picker so Escape closes it without coupling the
 *  shared picker components to the app keyboard registry. */
function EscapeClose({ onEscape, children }: { onEscape: () => void; children: ReactNode }) {
	useEscapeCapture(onEscape);
	return <>{children}</>;
}

export function openIconPicker(opts: {
	value: Icon | null;
	onChange: (icon: Icon | null) => void;
	labels?: Partial<IconPickerLabels>;
}): void {
	const r = ensureRoot();
	r.render(
		<EscapeClose onEscape={closePicker}>
			<IconPicker
				value={opts.value}
				labels={opts.labels}
				onChange={(icon) => opts.onChange(icon)}
				onClose={closePicker}
			/>
		</EscapeClose>,
	);
}

// ─── The shared object-icon picker affordance ───────────────────────────────
//
// The ONE "click the object's icon to change it" control, used by every
// app (Notes page icon, Database list icon, …). Markup + behaviour live
// here; the LOOK is the shell-owned `.bs-icon-pick` class injected into
// every app by `app-theme.ts` (apps declare zero theme values). DOM
// factory + React twin are the canonical pair pattern (mirrors
// `createEntityIconElement` / `<EntityIcon>`): non-React apps call
// `createIconPickerButton`, React apps render `<IconPickerButton>`.

/** The faint dashed-plus empty state — discoverable "add an icon" without
 *  painting a synthetic default glyph onto the object. */
export function AddIconGlyph() {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			className="bs-icon-pick__add"
		>
			<rect x="2" y="2" width="12" height="12" rx="3" strokeDasharray="2.5 2" />
			<line x1="8" y1="5.5" x2="8" y2="10.5" />
			<line x1="5.5" y1="8" x2="10.5" y2="8" />
		</svg>
	);
}

/** Imperative twin of `<AddIconGlyph>` for plain-DOM apps. */
export function createAddIconGlyph(): SVGSVGElement {
	const tpl = document.createElement("template");
	tpl.innerHTML =
		'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
		'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
		'class="bs-icon-pick__add"><rect x="2" y="2" width="12" height="12" rx="3" ' +
		'stroke-dasharray="2.5 2"/><line x1="8" y1="5.5" x2="8" y2="10.5"/>' +
		'<line x1="5.5" y1="8" x2="10.5" y2="8"/></svg>';
	return tpl.content.firstElementChild as SVGSVGElement;
}

export type IconPickerButtonOptions = {
	value: Icon | null;
	/** Glyph size in px. The button box is `size + 6`. Default 18. */
	size?: number;
	ariaLabel: string;
	onChange: (icon: Icon | null) => void;
	labels?: Partial<IconPickerLabels>;
	/** Rendered when the object has no own icon. Defaults to the
	 *  dashed-add glyph (a 'set me' affordance); callers that want a
	 *  type fallback (e.g. the per-object canonical icon from
	 *  `defaultIconForType`) supply their own builder. The picker still
	 *  treats `value === null` as 'no own icon set' regardless. */
	fallback?: () => Node;
};

/**
 * The shared object-icon picker button for non-React apps. Renders the
 * object's own universal icon (faint add-glyph when unset) and opens the
 * shared icon picker on click, repainting in place when it changes.
 */
export function createIconPickerButton(opts: IconPickerButtonOptions): HTMLButtonElement {
	const size = opts.size ?? 18;
	const box = size + 6;
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "bs-icon-pick";
	btn.setAttribute("aria-label", opts.ariaLabel);
	btn.setAttribute("aria-haspopup", "dialog");
	btn.style.width = `${box}px`;
	btn.style.height = `${box}px`;
	btn.style.fontSize = `${size}px`;

	let current = opts.value;
	const fallback = opts.fallback ?? (() => createAddIconGlyph());
	const paint = (): void => {
		// `createEntityIconElement` returns `HTMLElement | null` per its
		// signature, but the supplied `fallback` guarantees a Node here.
		// The `?? fallback()` keeps TS happy without changing behaviour.
		const node = createEntityIconElement(current, { size, fallback }) ?? fallback();
		btn.replaceChildren(node);
	};
	paint();
	btn.addEventListener("click", () => {
		openIconPicker({
			value: current,
			...(opts.labels ? { labels: opts.labels } : {}),
			onChange: (icon) => {
				current = icon;
				paint();
				opts.onChange(icon);
			},
		});
	});
	return btn;
}

/** React twin of `createIconPickerButton` — mounts the SDK DOM control
 *  into the React tree (adds nothing the DOM factory doesn't own). */
export function IconPickerButton(props: IconPickerButtonOptions) {
	const host = useRef<HTMLSpanElement>(null);
	const onChange = useRef(props.onChange);
	onChange.current = props.onChange;
	useEffect(() => {
		const el = host.current;
		if (!el) return;
		const btn = createIconPickerButton({
			value: props.value,
			...(props.size !== undefined ? { size: props.size } : {}),
			ariaLabel: props.ariaLabel,
			...(props.labels ? { labels: props.labels } : {}),
			onChange: (icon) => onChange.current(icon),
		});
		el.replaceChildren(btn);
		return () => el.replaceChildren();
	}, [props.value, props.size, props.ariaLabel, props.labels]);
	return <span ref={host} style={{ display: "inline-flex" }} />;
}

export function openCoverPicker(opts: {
	value: Cover | null;
	covers: CoverPickerService;
	onChange: (cover: Cover | null) => void;
	labels?: Partial<CoverPickerLabels>;
}): void {
	const r = ensureRoot();
	r.render(
		<EscapeClose onEscape={closePicker}>
			<CoverPicker
				value={opts.value}
				covers={opts.covers}
				labels={opts.labels}
				onChange={(cover) => opts.onChange(cover)}
				onClose={closePicker}
			/>
		</EscapeClose>,
	);
}

const INLINE_PROPERTY_HOST_STYLE_MARKER = "bs-picker-host-inline-property";
function ensureInlinePropertyHostStyles(): void {
	if (typeof document === "undefined") return;
	if (document.querySelector(`style[data-bs="${INLINE_PROPERTY_HOST_STYLE_MARKER}"]`)) return;
	const style = document.createElement("style");
	style.dataset.bs = INLINE_PROPERTY_HOST_STYLE_MARKER;
	style.textContent = `
.bs-picker-host__backdrop {
	position: fixed;
	inset: 0;
	background: rgba(0, 0, 0, 0.4);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 9000;
}
.bs-picker-host__panel {
	width: min(420px, 92vw);
	background: var(--bg, #ffffff);
	color: var(--text, #111111);
	border: 1px solid var(--border-strong, var(--border, rgba(0, 0, 0, 0.16)));
	border-radius: 10px;
	box-shadow:
		var(--shadow-lg, 0 10px 30px rgba(0, 0, 0, 0.25)),
		var(--shadow-sm, 0 2px 6px rgba(0, 0, 0, 0.12));
	overflow: hidden;
}`;
	document.head.appendChild(style);
}

/** Mount the shared `<InlinePropertyForm>` inside the picker-host root.
 *  Used by plain-DOM apps (Database column-adder for 9.3.5.U.b; future
 *  Graph subject-property surface, etc.) that need to mint a fresh
 *  `PropertyDef` without owning a React tree.
 *
 *  The form's commit handler returns the validated `{def, dictionary}`
 *  pair; the caller persists them (typically through
 *  `services.properties.setProperty` + `setDictionary`) and then closes
 *  the picker via `closePicker()`. Cancellation auto-closes via the
 *  passed `onClose`. */
export function openInlinePropertyForm(opts: {
	labels: InlinePropertyFormLabels;
	onCommit: (commit: InlinePropertyFormCommit) => void | Promise<void>;
	/** Optional one-line hook for surfaces that want to do something on
	 *  cancel beyond closing the picker (telemetry, focus restoration).
	 *  Cancellation already closes the picker; this fires after. */
	onCancel?: () => void;
	/** Forwarded to `<InlinePropertyForm>` — default `true`. */
	autoFocus?: boolean;
	/** Forwarded to `<InlinePropertyForm>` — entity types a Relation can
	 *  target (surfaces the "Links to" picker). */
	relationTargetTypes?: readonly RelationTargetType[];
}): void {
	ensureInlinePropertyHostStyles();
	const r = ensureRoot();
	r.render(
		<InlinePropertyHost
			labels={opts.labels}
			onCommit={opts.onCommit}
			{...(opts.onCancel ? { onCancel: opts.onCancel } : {})}
			{...(opts.autoFocus !== undefined ? { autoFocus: opts.autoFocus } : {})}
			{...(opts.relationTargetTypes ? { relationTargetTypes: opts.relationTargetTypes } : {})}
		/>,
	);
}

/** The shared picker-host wraps `<InlinePropertyForm>` in a backdrop +
 *  panel so it pops the same glass chrome as the icon / cover pickers.
 *  The form itself is unstyled-chrome by design — the host owns the
 *  surface, the form owns the inputs. */
function InlinePropertyHost(props: {
	labels: InlinePropertyFormLabels;
	onCommit: (commit: InlinePropertyFormCommit) => void | Promise<void>;
	onCancel?: () => void;
	autoFocus?: boolean;
	relationTargetTypes?: readonly RelationTargetType[];
}) {
	const handleCancel = (): void => {
		// Capture the caller's hook BEFORE `closePicker()` triggers the
		// synchronous React unmount — the closure stays trivially live
		// either way, but the ordering makes the lifecycle obvious to
		// the reader.
		const callerHook = props.onCancel;
		closePicker();
		callerHook?.();
	};
	useEscapeCapture(handleCancel);
	const handleCommit = async (commit: InlinePropertyFormCommit): Promise<void> => {
		await props.onCommit(commit);
		closePicker();
	};
	return (
		<div className="bs-picker-host__backdrop" role="presentation" onMouseDown={handleCancel}>
			<div
				className="bs-picker-host__panel"
				role="dialog"
				aria-modal="true"
				aria-label={props.labels.region}
				onMouseDown={(e) => e.stopPropagation()}
			>
				<InlinePropertyForm
					labels={props.labels}
					onCommit={handleCommit}
					onCancel={handleCancel}
					{...(props.autoFocus !== undefined ? { autoFocus: props.autoFocus } : {})}
					{...(props.relationTargetTypes ? { relationTargetTypes: props.relationTargetTypes } : {})}
				/>
			</div>
		</div>
	);
}
