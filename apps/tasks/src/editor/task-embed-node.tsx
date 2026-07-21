/**
 * TaskEmbedNode — a block-level reference to a vault entity rendered inline
 * inside the Tasks inspector body editor, mirroring Notes' `BlockEmbedNode`
 * (9.4.1). The persisted shape is a `{blockId, entityId}` reference plus
 * `entityType` + `label` snapshots so a freshly-loaded doc paints a
 * recognisable card before the live block boots — never the embedded
 * entity's content.
 *
 * v1 scope for Tasks (9.14.3): the `/task` slash command embeds a Task
 * entity, which resolves to the app's own `io.brainstorm.tasks/inline-task`
 * BP block. When the registry reports a `BlockProtocol` provider AND the
 * block-bundle loader (9.5.x) serves its source, the card lights up a live
 * `<BpBlockMount>` running `dist/blocks/inline-task.js` in the sandboxed
 * frame; otherwise it stays a static chrome card (icon + title + type).
 *
 * Hostile-body hardening matches the Notes node: every persisted string is
 * clamped (length + format-control strip) on import so a malicious imported
 * body can't smuggle multi-megabyte ids or Trojan-Source labels into the
 * graph.
 */

import { BpBlockMount, type BpBlockMountHandle } from "@brainstorm-os/sdk/block-mount";
import { BlockRendererKind, useBlockRenderer } from "@brainstorm-os/sdk/block-registry";
import { BlockControlKind } from "@brainstorm-os/sdk/block-runtime";
import {
	DecoratorNode,
	type EditorConfig,
	type LexicalNode,
	type NodeKey,
	type SerializedLexicalNode,
} from "lexical";
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n/t";
import { getBrainstorm } from "../storage/runtime";

export const TASK_EMBED_NODE_TYPE = "task-embed";
const TASK_EMBED_NODE_VERSION = 1 as const;

/** The shell-provided generic preview block. Until the providing app's BP
 *  block bundle is serveable, every embed renders through this id (the
 *  fallback-renderer path). Kept local so the node doesn't import the SDK
 *  registry just for the constant. */
export const SHELL_ENTITY_CARD_BLOCK_ID = "io.brainstorm.shell/entity-card/v1";

const MAX_FIELD_LEN = 1024;

/** ASCII C0 controls + Unicode bidi-override / zero-width / isolate codes —
 *  the load-bearing characters in Trojan-Source / homoglyph label attacks.
 *  Built via `new RegExp` + concatenated `\u` escapes so the source stays
 *  clean (sidesteps biome's `noControlCharactersInRegex`). Mirrors the Notes
 *  node's `STRIP_FORMAT_CONTROLS_RE`. */
const STRIP_FORMAT_CONTROLS_RE = new RegExp(
	"[" +
		"\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F" +
		"\\u200B-\\u200F" +
		"\\u202A-\\u202E" +
		"\\u2066-\\u2069" +
		"]",
	"g",
);

function clampField(value: unknown): string {
	if (typeof value !== "string") return "";
	const stripped = value.replace(STRIP_FORMAT_CONTROLS_RE, "");
	return stripped.length > MAX_FIELD_LEN ? stripped.slice(0, MAX_FIELD_LEN) : stripped;
}

export type SerializedTaskEmbedNode = SerializedLexicalNode & {
	type: typeof TASK_EMBED_NODE_TYPE;
	version: typeof TASK_EMBED_NODE_VERSION;
	blockId: string;
	entityId: string;
	entityType: string;
	label: string;
};

export class TaskEmbedNode extends DecoratorNode<JSX.Element> {
	__blockId: string;
	__entityId: string;
	__entityType: string;
	__label: string;

	static override getType(): string {
		return TASK_EMBED_NODE_TYPE;
	}

	static override clone(node: TaskEmbedNode): TaskEmbedNode {
		return new TaskEmbedNode(
			node.__blockId,
			node.__entityId,
			node.__entityType,
			node.__label,
			node.__key,
		);
	}

	constructor(blockId: string, entityId: string, entityType: string, label: string, key?: NodeKey) {
		super(key);
		this.__blockId = blockId;
		this.__entityId = entityId;
		this.__entityType = entityType;
		this.__label = label;
	}

	static override importJSON(s: SerializedTaskEmbedNode): TaskEmbedNode {
		const blockId = clampField(s.blockId);
		return new TaskEmbedNode(
			blockId.length > 0 ? blockId : SHELL_ENTITY_CARD_BLOCK_ID,
			clampField(s.entityId),
			clampField(s.entityType),
			clampField(s.label),
		);
	}

	override exportJSON(): SerializedTaskEmbedNode {
		return {
			type: TASK_EMBED_NODE_TYPE,
			version: TASK_EMBED_NODE_VERSION,
			blockId: this.__blockId,
			entityId: this.__entityId,
			entityType: this.__entityType,
			label: this.__label,
		};
	}

	override createDOM(_config: EditorConfig): HTMLElement {
		const el = document.createElement("div");
		el.className = "tasks-embed-host";
		return el;
	}

	override updateDOM(): false {
		return false;
	}

	getBlockId(): string {
		return this.__blockId;
	}

	getEntityId(): string {
		return this.__entityId;
	}

	getEntityType(): string {
		return this.__entityType;
	}

	getLabel(): string {
		return this.__label;
	}

	/** Plain-text view — read by screen readers, Markdown export, and search
	 *  indexing, all of which want the human label not a URI. */
	override getTextContent(): string {
		return this.__label;
	}

	override isInline(): false {
		return false;
	}

	override isKeyboardSelectable(): boolean {
		return true;
	}

	override decorate(): JSX.Element {
		return (
			<TaskEmbedView
				blockId={this.__blockId}
				entityId={this.__entityId}
				entityType={this.__entityType}
				label={this.__label}
			/>
		);
	}
}

/** Per-blockId cache of the block bundle source — one broker round-trip per
 *  distinct block, shared across every embed of it. A bundle is immutable for
 *  the life of an installed app version, so a process-lifetime cache is
 *  correct (mirrors the Notes node). */
const blockSourceCache = new Map<string, Promise<string | null>>();

function fetchBlockSource(blockId: string): Promise<string | null> {
	let cached = blockSourceCache.get(blockId);
	if (!cached) {
		const svc = getBrainstorm()?.services.blocks;
		cached = svc ? svc.source(blockId).catch(() => null) : Promise.resolve(null);
		blockSourceCache.set(blockId, cached);
	}
	return cached;
}

function useBlockSource(blockId: string, enabled: boolean): string | null | undefined {
	const [source, setSource] = useState<string | null | undefined>(undefined);
	useEffect(() => {
		if (!enabled) return;
		let live = true;
		fetchBlockSource(blockId).then((s) => {
			if (live) setSource(s);
		});
		return () => {
			live = false;
		};
	}, [blockId, enabled]);
	return source;
}

/** Hard ceiling on a live embed's height — the block reports its content
 *  height; an unbounded report can't blow out the host doc. */
const MAX_EMBED_HEIGHT_PX = 600;

/** Stable empty-capabilities reference. v1 grants no capabilities to the
 *  embedded BP block; the broker plumbing arrives with 9.3.3's Hook handler.
 *  The embedded inline-task's graph reads/writes flow through `bp.dispatch`
 *  under Tasks' own grants (9.4.5), not a per-block capability. */
const EMPTY_CAPS: readonly string[] = Object.freeze([]);

/** Reverse-DNS id → human-readable tail (`brainstorm/Task/v1` → `Task`). */
function entityTypeLabel(entityType: string): string {
	if (!entityType) return t("tasks.embed.typeUnknown");
	const lastSlash = entityType.lastIndexOf("/");
	const tail = lastSlash >= 0 ? entityType.slice(lastSlash + 1) : entityType;
	const trimmed = tail.replace(/^v\d+$/, "");
	if (trimmed.length > 0) return trimmed;
	const penultimate = entityType.slice(0, lastSlash);
	const prevSlash = penultimate.lastIndexOf("/");
	return prevSlash >= 0 ? penultimate.slice(prevSlash + 1) : penultimate;
}

function openEntity(entityId: string, entityType: string): void {
	void getBrainstorm()?.services.intents?.dispatch({
		verb: "open",
		payload: { entityId, entityType },
	});
}

function TaskEmbedView({
	blockId,
	entityId,
	entityType,
	label,
}: {
	blockId: string;
	entityId: string;
	entityType: string;
	label: string;
}) {
	// Forward-compat upgrade: an embed inserted before its provider registered
	// a block froze the fallback card id. Re-resolve by entity type at render
	// so the SAME persisted node lights up the live block once a provider
	// exists. Only the fallback sentinel is re-resolved; an explicit id wins.
	const [typeBlockId, setTypeBlockId] = useState<string | null>(null);
	useEffect(() => {
		const blocks = getBrainstorm()?.services.blocks;
		if (blockId !== SHELL_ENTITY_CARD_BLOCK_ID || !blocks?.forType) {
			setTypeBlockId(null);
			return;
		}
		let cancelled = false;
		blocks
			.forType(entityType)
			.then((id) => {
				if (!cancelled) setTypeBlockId(id && id !== SHELL_ENTITY_CARD_BLOCK_ID ? id : null);
			})
			.catch(() => {
				if (!cancelled) setTypeBlockId(null);
			});
		return () => {
			cancelled = true;
		};
	}, [blockId, entityType]);

	const effectiveBlockId =
		blockId === SHELL_ENTITY_CARD_BLOCK_ID && typeBlockId ? typeBlockId : blockId;
	const renderer = useBlockRenderer(effectiveBlockId);
	const rendererKind = renderer?.kind ?? "loading";
	const isBp = renderer?.kind === BlockRendererKind.BlockProtocol;
	const display = label.trim() || t("tasks.embed.untitled");
	const typeLabel = entityTypeLabel(entityType);
	const bpService = getBrainstorm()?.services.bp;
	const source = useBlockSource(effectiveBlockId, isBp);
	const [height, setHeight] = useState<number | null>(null);
	const mountHandle = useRef<BpBlockMountHandle | null>(null);

	const onBlockMessage = useCallback((payload: unknown) => {
		const m = payload as { kind?: string; entityId?: string; entityType?: string; px?: number };
		if (m?.kind === BlockControlKind.Navigate && typeof m.entityId === "string") {
			openEntity(m.entityId, typeof m.entityType === "string" ? m.entityType : "");
		} else if (m?.kind === BlockControlKind.Height && typeof m.px === "number") {
			setHeight(Math.max(0, Math.min(m.px, MAX_EMBED_HEIGHT_PX)));
		}
	}, []);

	if (isBp) {
		const liveMount = typeof source === "string" && source.length > 0;
		return (
			<div
				className="tasks-embed-card tasks-embed-card--bp"
				data-entity-id={entityId}
				data-entity-type={entityType}
				data-block-id={effectiveBlockId}
				data-renderer-kind={rendererKind}
				data-block-live={liveMount ? "true" : "false"}
			>
				<button
					type="button"
					className="tasks-embed-card-chrome"
					onClick={() => openEntity(entityId, entityType)}
				>
					<span className="tasks-embed-card-body">
						<span className="tasks-embed-card-title">{display}</span>
						<span className="tasks-embed-card-type">{typeLabel}</span>
					</span>
				</button>
				{liveMount ? (
					<BpBlockMount
						entityId={entityId}
						capabilities={EMPTY_CAPS}
						blockId={effectiveBlockId}
						handleRef={mountHandle}
						onMessage={onBlockMessage}
						{...(bpService ? { bp: bpService } : {})}
						className="tasks-embed-card-mount"
						title={display}
						{...(height !== null ? { style: { height } } : {})}
					/>
				) : null}
			</div>
		);
	}

	return (
		<button
			type="button"
			className="tasks-embed-card"
			data-entity-id={entityId}
			data-entity-type={entityType}
			data-block-id={effectiveBlockId}
			data-renderer-kind={rendererKind}
			onClick={() => openEntity(entityId, entityType)}
		>
			<span className="tasks-embed-card-body">
				<span className="tasks-embed-card-title">{display}</span>
				<span className="tasks-embed-card-type">{typeLabel}</span>
			</span>
		</button>
	);
}

export function $createTaskEmbedNode(
	entityId: string,
	entityType: string,
	label: string,
	blockId: string = SHELL_ENTITY_CARD_BLOCK_ID,
): TaskEmbedNode {
	return new TaskEmbedNode(blockId, entityId, entityType, label);
}

export function $isTaskEmbedNode(node: LexicalNode | null | undefined): node is TaskEmbedNode {
	return node instanceof TaskEmbedNode;
}
