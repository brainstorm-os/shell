/**
 * `io.brainstorm.calendar/inline-event` — a single live event, rendered inline
 * in a host document via the BP block frame. Shows the event's title, time
 * range, and location; a click opens the event in the Calendar app. Read-only
 * (an event's edits live in the app). Runs in the sandbox via
 * `@brainstorm-os/sdk/block-runtime`. Pure DOM.
 */

import { type BlockRuntimeContext, startBlock } from "@brainstorm-os/sdk/block-runtime";

interface BpEntity {
	entityId: string;
	entityTypeId: string;
	properties: Record<string, unknown>;
	updatedAt: number;
}

function eventTitle(props: Record<string, unknown>): string {
	const title = props.title ?? props.name;
	return typeof title === "string" && title.length > 0 ? title : "Untitled event";
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Human time line: "Mon, Jun 9" (all-day) or "Mon, Jun 9 · 9:00 – 10:00 AM". */
function timeLabel(props: Record<string, unknown>): string {
	const start = num(props.start);
	if (start === null) return "";
	const allDay = props.allDay === true;
	const startDate = new Date(start);
	try {
		const day = startDate.toLocaleDateString(undefined, {
			weekday: "short",
			month: "short",
			day: "numeric",
		});
		if (allDay) return day;
		const time = (d: Date): string =>
			d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
		const end = num(props.end);
		return end !== null
			? `${day} · ${time(startDate)} – ${time(new Date(end))}`
			: `${day} · ${time(startDate)}`;
	} catch {
		return "";
	}
}

// Colours come from the host theme tokens the block-runtime mirrors onto
// `:root` (BlockControlKind.Theme); the `var(--…, fallback)` literals only
// paint before the theme lands / in standalone tests. No
// `prefers-color-scheme` overrides — the active theme is the source of truth.
const STYLES = `
* { box-sizing: border-box; }
body { margin: 0; }
.bsevt { display: flex; gap: 10px; padding: 10px 12px; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--color-text-primary, #1c1c1e); cursor: pointer; }
.bsevt:hover { background: var(--color-accent-subtle, rgba(127,127,127,.07)); }
.bsevt__rail { flex: 0 0 auto; width: 3px; border-radius: 2px; background: var(--color-accent-default, #3b82f6); }
.bsevt__body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.bsevt__title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bsevt__meta { color: var(--color-text-tertiary, #8a8a8e); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bsevt__error { padding: 10px 12px; color: var(--color-text-tertiary, #8a8a8e); }
`;

function injectStyles(doc: Document): void {
	if (doc.getElementById("bsevt-styles")) return;
	const style = doc.createElement("style");
	style.id = "bsevt-styles";
	style.textContent = STYLES;
	doc.head.appendChild(style);
}

export function bootInlineEvent(ctx: BlockRuntimeContext): void {
	injectStyles(ctx.root.ownerDocument);
	const doc = ctx.root.ownerDocument;

	ctx.onLoad(async () => {
		let event: BpEntity | null = null;
		try {
			event = await ctx.graph<BpEntity>("getEntity", { entityId: ctx.entityId });
		} catch {
			event = null;
		}
		ctx.root.replaceChildren();
		if (!event) {
			ctx.root.className = "";
			const err = doc.createElement("div");
			err.className = "bsevt__error";
			err.textContent = "Couldn't load this event.";
			ctx.root.append(err);
			ctx.reportHeight(ctx.root.scrollHeight);
			return;
		}
		renderEvent(ctx, event);
		ctx.reportHeight(ctx.root.scrollHeight);
	});
}

startBlock(bootInlineEvent);

function renderEvent(
	ctx: {
		root: HTMLElement;
		navigate: (id: string, type: string) => void;
	},
	event: BpEntity,
): void {
	const doc = ctx.root.ownerDocument;
	ctx.root.className = "bsevt";
	ctx.root.addEventListener("click", () => ctx.navigate(event.entityId, event.entityTypeId));

	const rail = doc.createElement("span");
	rail.className = "bsevt__rail";
	const body = doc.createElement("div");
	body.className = "bsevt__body";

	const title = doc.createElement("span");
	title.className = "bsevt__title";
	title.textContent = eventTitle(event.properties);
	body.append(title);

	const when = timeLabel(event.properties);
	if (when) {
		const meta = doc.createElement("span");
		meta.className = "bsevt__meta";
		meta.textContent = when;
		body.append(meta);
	}
	const location = event.properties.location;
	if (typeof location === "string" && location.length > 0) {
		const loc = doc.createElement("span");
		loc.className = "bsevt__meta";
		loc.textContent = location;
		body.append(loc);
	}

	ctx.root.append(rail, body);
}
