/**
 * `io.brainstorm.tasks/inline-task` — a single live task, rendered inline in
 * a host document via the BP block frame. Read + act: shows the task's
 * checkbox / title / due chip, and a checkbox toggle writes the done state
 * back through the BP graph (`updateEntity`). A title click opens the task in
 * the Tasks app. Runs in the sandbox (no ambient authority) via
 * `@brainstorm/sdk/block-runtime`. Pure DOM.
 */

import { type BlockRuntimeContext, startBlock } from "@brainstorm/sdk/block-runtime";
import { TaskStatus } from "../../types/task";

interface BpEntity {
	entityId: string;
	entityTypeId: string;
	properties: Record<string, unknown>;
	updatedAt: number;
}

function isDone(props: Record<string, unknown>): boolean {
	return props.completedAt != null || props.statusKey === TaskStatus.Done;
}

function taskTitle(props: Record<string, unknown>): string {
	const name = props.name ?? props.title;
	return typeof name === "string" && name.length > 0 ? name : "Untitled task";
}

/** Format a due timestamp as a short, locale-aware day label. */
function dueLabel(due: unknown): string | null {
	if (typeof due !== "number" || !Number.isFinite(due)) return null;
	try {
		return new Date(due).toLocaleDateString(undefined, { month: "short", day: "numeric" });
	} catch {
		return null;
	}
}

// Colours come from the host theme tokens the block-runtime mirrors onto
// `:root` (BlockControlKind.Theme); the `var(--…, fallback)` literals only
// paint before the theme lands / in standalone tests. No
// `prefers-color-scheme` overrides — the active theme is the source of truth.
const STYLES = `
* { box-sizing: border-box; }
body { margin: 0; }
.bstask { display: flex; align-items: center; gap: 8px; padding: 8px 10px; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--color-text-primary, #1c1c1e); }
.bstask__check { appearance: none; width: 16px; height: 16px; flex: 0 0 auto; border: 1.5px solid var(--color-border-strong, #b0b0b5); border-radius: 4px; cursor: pointer; position: relative; margin: 0; background: transparent; }
.bstask__check:checked { background: var(--color-accent-default, #3b82f6); border-color: var(--color-accent-default, #3b82f6); }
.bstask__check:checked::after { content: ""; position: absolute; left: 4.5px; top: 1.5px; width: 4px; height: 8px; border: solid var(--color-accent-text, #fff); border-width: 0 2px 2px 0; transform: rotate(45deg); }
.bstask__title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.bstask__title:hover { text-decoration: underline; }
.bstask--done .bstask__title { color: var(--color-text-tertiary, #8a8a8e); text-decoration: line-through; }
.bstask__due { flex: 0 0 auto; color: var(--color-text-tertiary, #8a8a8e); font-size: 12px; }
.bstask__error { padding: 8px 10px; color: var(--color-text-tertiary, #8a8a8e); font: 13px -apple-system, sans-serif; }
`;

function injectStyles(doc: Document): void {
	if (doc.getElementById("bstask-styles")) return;
	const style = doc.createElement("style");
	style.id = "bstask-styles";
	style.textContent = STYLES;
	doc.head.appendChild(style);
}

export function bootInlineTask(ctx: BlockRuntimeContext): void {
	injectStyles(ctx.root.ownerDocument);
	const doc = ctx.root.ownerDocument;

	ctx.onLoad(async () => {
		let task: BpEntity | null = null;
		try {
			task = await ctx.graph<BpEntity>("getEntity", { entityId: ctx.entityId });
		} catch {
			task = null;
		}
		ctx.root.replaceChildren();
		if (!task) {
			const err = doc.createElement("div");
			err.className = "bstask__error";
			err.textContent = "Couldn't load this task.";
			ctx.root.append(err);
			ctx.reportHeight(ctx.root.scrollHeight);
			return;
		}
		renderTask(ctx, task);
		ctx.reportHeight(ctx.root.scrollHeight);
	});
}

startBlock(bootInlineTask);

function renderTask(
	ctx: {
		root: HTMLElement;
		graph: <T>(m: string, d: unknown) => Promise<T>;
		navigate: (id: string, type: string) => void;
		reportHeight: (px: number) => void;
	},
	task: BpEntity,
): void {
	const doc = ctx.root.ownerDocument;
	const done = isDone(task.properties);
	ctx.root.className = done ? "bstask bstask--done" : "bstask";

	const check = doc.createElement("input");
	check.type = "checkbox";
	check.className = "bstask__check";
	check.checked = done;
	check.addEventListener("change", () => {
		const next = check.checked;
		// Optimistic: reflect the toggle immediately, then write back. A denied
		// write (host app lacks entities.write for this type) leaves the UI as
		// toggled until the next refresh ping re-reads the true state.
		ctx.root.classList.toggle("bstask--done", next);
		void ctx
			.graph("updateEntity", {
				entityId: task.entityId,
				entityTypeId: task.entityTypeId,
				properties: next
					? { statusKey: TaskStatus.Done, completedAt: Date.now() }
					: { statusKey: null, completedAt: null },
			})
			.catch(() => {
				/* revert handled by the next refresh ping. */
			});
	});

	const title = doc.createElement("span");
	title.className = "bstask__title";
	title.textContent = taskTitle(task.properties);
	title.addEventListener("click", () => ctx.navigate(task.entityId, task.entityTypeId));

	ctx.root.append(check, title);

	const due = dueLabel(task.properties.dueAt);
	if (due) {
		const chip = doc.createElement("span");
		chip.className = "bstask__due";
		chip.textContent = due;
		ctx.root.append(chip);
	}
}
