/**
 * `io.brainstorm.tasks/inline-task` — a single live task, rendered inline in
 * a host document via the BP block frame. Read + act: shows the task's
 * checkbox / title / due chip, and a checkbox toggle writes the done state
 * back through the BP graph (`updateEntity`). A title click opens the task in
 * the Tasks app. Runs in the sandbox (no ambient authority) via
 * `@brainstorm-os/sdk/block-runtime`. Pure DOM.
 */

import { type BlockRuntimeContext, startBlock } from "@brainstorm-os/sdk/block-runtime";
import { entityTitleOr } from "@brainstorm-os/sdk/entity-title";
import {
	CompletionState,
	completionPatch,
	completionStateOf,
	nextCompletionState,
} from "../../logic/task-status";
import { TaskStatus } from "../../types/task";

interface BpEntity {
	entityId: string;
	entityTypeId: string;
	properties: Record<string, unknown>;
	updatedAt: number;
}

/** The block reads the raw property bag, so it normalises the two fields
 *  the shared completion model keys on. A Done status with no stamp (an
 *  older write path) still reads as done. */
function completionOf(props: Record<string, unknown>): CompletionState {
	const statusKey = typeof props.statusKey === "string" ? props.statusKey : null;
	const completedAt =
		typeof props.completedAt === "number"
			? props.completedAt
			: statusKey === TaskStatus.Done
				? 0
				: null;
	return completionStateOf({ completedAt, statusKey });
}

const COMPLETION_ARIA: Record<CompletionState, string> = {
	[CompletionState.Open]: "Open — mark done",
	[CompletionState.Done]: "Done — mark won't do",
	[CompletionState.WontDo]: "Won't do — reopen",
};

function paintCompletion(root: HTMLElement, check: HTMLInputElement, state: CompletionState): void {
	check.checked = state === CompletionState.Done;
	check.indeterminate = state === CompletionState.WontDo;
	check.setAttribute("aria-label", COMPLETION_ARIA[state]);
	root.classList.toggle("bstask--done", state === CompletionState.Done);
	root.classList.toggle("bstask--wont-do", state === CompletionState.WontDo);
}

function taskTitle(props: Record<string, unknown>): string {
	return entityTitleOr(props, "Untitled task");
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
.bstask__check:indeterminate { border-style: dashed; }
.bstask__check:indeterminate::after { content: ""; position: absolute; left: 3px; right: 3px; top: 6px; height: 1.5px; background: var(--color-text-tertiary, #8a8a8e); }
.bstask--wont-do .bstask__title { color: var(--color-text-tertiary, #8a8a8e); text-decoration: line-through; font-style: italic; }
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
	let state = completionOf(task.properties);
	let statusKey = typeof task.properties.statusKey === "string" ? task.properties.statusKey : null;
	ctx.root.className = "bstask";

	const check = doc.createElement("input");
	check.type = "checkbox";
	check.className = "bstask__check";
	paintCompletion(ctx.root, check, state);
	// 9.14.17 — the same three-state cycle as the Tasks app: open → done →
	// won't do → open. The native toggle is overridden with the cycle's
	// next face. Optimistic: reflect it immediately, then write back; a
	// denied write is corrected by the next refresh ping re-reading the row.
	check.addEventListener("change", () => {
		state = nextCompletionState(state);
		paintCompletion(ctx.root, check, state);
		const patch = completionPatch(statusKey, state, Date.now());
		statusKey = patch.statusKey;
		void ctx
			.graph("updateEntity", {
				entityId: task.entityId,
				entityTypeId: task.entityTypeId,
				properties: patch,
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
