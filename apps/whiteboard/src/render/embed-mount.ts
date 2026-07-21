/**
 * `embed-mount` — the host side of the Embedded node (9.17.4).
 *
 * An Embedded whiteboard node hosts ANY vault entity's Block Protocol block
 * inside the board. This is the inverse of the 9.17.7 `embedded-whiteboard`
 * block (the board rendered AS a block inside a host doc): here the board is
 * the BP *host*, mounting another app's block bundle through the proven 9.5.x
 * `bsblock://` loader.
 *
 * It mirrors the React `@brainstorm-os/sdk/block-mount` seam's lifecycle but
 * imperatively, because the whiteboard renderer is pure DOM (no React, per the
 * frontend-stack rule for self-contained draw surfaces): resolve the providing
 * app's block id (an explicit `#block-<id>` fragment, else `services.blocks
 * .forType(entityType)`), fetch its bundle source, and mount the sandboxed
 * opaque-origin iframe via `createBlockFrame` + `createBlockFrameTransport`.
 * Block→host control traffic is forwarded the same way Notes' embed does it —
 * `navigate` opens the entity, `height` autosizes (bounded), `theme-request`
 * pushes the live theme — and BP graph traffic falls through to `services.bp`.
 *
 * The whiteboard repaints the whole node layer on every interaction
 * (`paintNodes` → `replaceChildren`), which would tear an iframe down and
 * remount it (destroying the live block) on every drag tick. So the controller
 * keeps its container element across repaints: `renderNode` re-parents the
 * SAME container into the freshly-built node, and the iframe inside it is only
 * mounted once. A `EmbedMountRegistry` reaps controllers whose node has been
 * deleted.
 */

import {
	BlockFramePhase,
	type BlockFrameTransport,
	createBlockFrame,
	createBlockFrameTransport,
	defaultMintChannelId,
} from "@brainstorm-os/sdk/block-frame";
import { BlockControlKind, collectBlockThemeVars } from "@brainstorm-os/sdk/block-runtime";
import { parseBrainstormEntityUri } from "@brainstorm-os/sdk/note-references";

/** Hard ceiling on a live embed's reported height — a runaway block can't blow
 *  the node box past this; beyond it the iframe scrolls internally. */
export const MAX_EMBED_HEIGHT_PX = 800;

export interface EmbedCandidate {
	readonly id: string;
	readonly type: string;
	readonly label: string;
}

/** The entity shape the picker reads — structural so both the sdk-types
 *  `VaultEntity` and the app's narrowed `VaultEntitySummary` satisfy it. */
export interface EmbedTargetEntity {
	readonly id: string;
	readonly type: string;
	readonly properties: Record<string, unknown>;
	readonly deletedAt: number | null;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Pick a human label for an entity from its common name-bearing properties,
 *  falling back to the id so a row is never blank. */
export function embedEntityLabel(entity: EmbedTargetEntity): string {
	const props = entity.properties;
	const name = str(props.name) || str(props.title) || str(props.label);
	return name.trim().length > 0 ? name.trim() : entity.id;
}

/** The pickable embed targets: live (non-deleted) entities, excluding the board
 *  doing the embedding (a board can't embed itself), sorted by label. Pure +
 *  unit-tested — the picker UI is a thin shell over this. */
export function embedCandidates(
	entities: readonly EmbedTargetEntity[],
	selfEntityId: string,
): EmbedCandidate[] {
	return entities
		.filter((e) => e.deletedAt === null && e.id !== selfEntityId)
		.map((e) => ({ id: e.id, type: e.type, label: embedEntityLabel(e) }))
		.sort((a, b) => a.label.localeCompare(b.label));
}

/** The block-registry slice the mount needs (structural — the app's narrowed
 *  runtime type satisfies it without importing the full sdk-types service). */
export interface EmbedBlocksService {
	source(blockId: string): Promise<string | null>;
	forType(entityType: string): Promise<string | null>;
}

/** The BP host-router slice — forwards a block's graph message + returns the
 *  (untyped, shell-revalidated) response. */
export interface EmbedBpService {
	dispatch(entityId: string, message: unknown): Promise<unknown>;
}

/** The slice of the shell runtime the mount needs. Narrowed (not the full
 *  runtime) so the controller is trivially fakeable in tests. */
export interface EmbedMountServices {
	readonly blocks?: EmbedBlocksService | undefined;
	readonly bp?: EmbedBpService | undefined;
}

/** Host callbacks the controller fires. `navigate` opens the embedded entity in
 *  its app; `resize` autosizes the node box to the block's reported height. */
export interface EmbedMountCallbacks {
	navigate(entityId: string, entityType: string): void;
	resize(heightPx: number): void;
}

/** Injection points mirroring `createBlockFrame` — tests in jsdom (which has no
 *  native IntersectionObserver / ResizeObserver) supply fakes. Production leaves
 *  them undefined. `mintChannelId` lets tests pin a deterministic id. */
export interface EmbedMountInjection {
	readonly IntersectionObserverImpl?: typeof IntersectionObserver;
	readonly ResizeObserverImpl?: typeof ResizeObserver;
	readonly mintChannelId?: () => string;
	readonly host?: Pick<Window, "addEventListener" | "removeEventListener">;
	/** Reads the live theme custom properties to push into the frame. Defaults
	 *  to scraping `document.documentElement`'s inline style. */
	readonly collectTheme?: () => { vars: Record<string, string>; colorScheme: string };
}

export interface EmbedMountOptions {
	readonly entityRef: string;
	/** The embedded entity's type, captured at insert. Used to resolve the
	 *  providing app's block id when the ref carries no explicit `#block-`
	 *  fragment. */
	readonly entityType?: string | undefined;
	readonly services: EmbedMountServices;
	readonly callbacks: EmbedMountCallbacks;
	/** Pre-translated accessible label for the iframe + chrome card. */
	readonly title: string;
	readonly injection?: EmbedMountInjection;
}

/** Parse the entity ref into the id + the explicit block id (if any). Returns
 *  null for a non-`brainstorm://entity/` ref (a malformed node) so the caller
 *  paints the fallback instead of mounting nothing. */
export function parseEmbedRef(entityRef: string): { entityId: string; blockId?: string } | null {
	const parsed = parseBrainstormEntityUri(entityRef);
	if (!parsed) return null;
	const result: { entityId: string; blockId?: string } = { entityId: parsed.entityId };
	if (parsed.blockId) result.blockId = parsed.blockId;
	return result;
}

/** Resolve the block id to mount: an explicit `#block-<id>` fragment wins;
 *  otherwise ask the registry which app renders this entity type. `null` =
 *  no provider (paint the fallback chrome, don't mount an iframe). */
export async function resolveEmbedBlockId(
	explicitBlockId: string | undefined,
	entityType: string | undefined,
	blocks: Pick<EmbedBlocksService, "forType"> | undefined,
): Promise<string | null> {
	if (explicitBlockId) return explicitBlockId;
	if (!entityType || !blocks?.forType) return null;
	try {
		const id = await blocks.forType(entityType);
		return id && id.length > 0 ? id : null;
	} catch {
		return null;
	}
}

/** Shared SDK collector — reads COMPUTED token values (the inline-only
 *  harvest shipped blocks three header vars and a light grid in dark
 *  themes, F-210). */
const defaultCollectTheme = collectBlockThemeVars;

/** One live BP-block embed. Owns a container `<div>` (which `renderNode`
 *  re-parents across repaints) and, once the block bundle resolves, the
 *  sandboxed iframe + transport inside it. Idempotent `dispose()`. */
export class EmbedMountController {
	readonly container: HTMLDivElement;
	private frame: ReturnType<typeof createBlockFrame> | null = null;
	private transport: BlockFrameTransport | null = null;
	private disposed = false;
	private readonly opts: EmbedMountOptions;
	private readonly entityId: string;
	private readonly explicitBlockId: string | undefined;

	private constructor(
		opts: EmbedMountOptions,
		container: HTMLDivElement,
		entityId: string,
		explicitBlockId: string | undefined,
	) {
		this.opts = opts;
		this.container = container;
		this.entityId = entityId;
		this.explicitBlockId = explicitBlockId;
	}

	/** Build a controller + kick off block-id resolution + mount. Returns null
	 *  for a malformed entity ref (caller paints the fallback). */
	static create(opts: EmbedMountOptions): EmbedMountController | null {
		const parsed = parseEmbedRef(opts.entityRef);
		if (!parsed) return null;
		const container = document.createElement("div");
		container.className = "whiteboard__embed-mount";
		const controller = new EmbedMountController(opts, container, parsed.entityId, parsed.blockId);
		void controller.start();
		return controller;
	}

	private async start(): Promise<void> {
		const blockId = await resolveEmbedBlockId(
			this.explicitBlockId,
			this.opts.entityType,
			this.opts.services.blocks,
		);
		if (this.disposed || !blockId) {
			if (!blockId) this.container.dataset.embedState = "no-provider";
			return;
		}
		let source: string | null = null;
		try {
			source = (await this.opts.services.blocks?.source?.(blockId)) ?? null;
		} catch {
			source = null;
		}
		if (this.disposed) return;
		if (!source) {
			this.container.dataset.embedState = "no-bundle";
			return;
		}
		this.mount(blockId);
	}

	private mount(blockId: string): void {
		const inj = this.opts.injection ?? {};
		// Mint ONE channel id up front and thread it through both the frame's
		// bootstrap (so the bundle's inner transport knows the id to gate
		// inbound on) AND the transport (which must mint the same id) — the
		// React seam's discipline. Tests pin it via `mintChannelId`.
		const channelId = (inj.mintChannelId ?? defaultMintChannelId)();
		const frame = createBlockFrame({
			container: this.container,
			title: this.opts.title,
			blockId,
			bootstrap: { channelId, entityId: this.entityId },
			...(inj.IntersectionObserverImpl
				? { IntersectionObserverImpl: inj.IntersectionObserverImpl }
				: {}),
			...(inj.ResizeObserverImpl ? { ResizeObserverImpl: inj.ResizeObserverImpl } : {}),
			onPhase: (phase) => {
				if (phase === BlockFramePhase.Mounted) this.transport?.flushStartup();
			},
		});
		this.frame = frame;

		const transport = createBlockFrameTransport({
			handle: frame,
			entityId: this.entityId,
			// v1 grants embedded blocks no capabilities — the broker re-checks
			// every BP call regardless; this list is advisory.
			capabilities: [],
			mintChannelId: () => channelId,
			...(inj.host ? { host: inj.host } : {}),
			onMessage: (payload) => this.onBlockMessage(payload),
		});
		this.transport = transport;
		transport.flushStartup();

		const onLoad = (): void => this.transport?.flushStartup(true);
		frame.iframe.addEventListener("load", onLoad);
		this.onLoad = onLoad;
		this.container.dataset.embedState = "live";
	}

	private onLoad: (() => void) | null = null;

	private pushTheme(): void {
		const collect = this.opts.injection?.collectTheme ?? defaultCollectTheme;
		const { vars, colorScheme } = collect();
		this.transport?.send({ kind: BlockControlKind.Theme, vars, colorScheme });
	}

	/** Re-push the live theme into the frame — `renderNode` calls this on a host
	 *  theme switch so every embed repaints in lockstep with the board. */
	refreshTheme(): void {
		if (this.transport) this.pushTheme();
	}

	/** Ping the live block to re-query + repaint after a vault write. */
	refresh(): void {
		this.transport?.send({ kind: BlockControlKind.Refresh });
	}

	private onBlockMessage(payload: unknown): void {
		const m = payload as {
			kind?: string;
			entityId?: string;
			entityType?: string;
			px?: number;
		};
		if (m?.kind === BlockControlKind.Navigate && typeof m.entityId === "string") {
			this.opts.callbacks.navigate(m.entityId, typeof m.entityType === "string" ? m.entityType : "");
			return;
		}
		if (m?.kind === BlockControlKind.Height && typeof m.px === "number") {
			this.opts.callbacks.resize(Math.max(0, Math.min(m.px, MAX_EMBED_HEIGHT_PX)));
			return;
		}
		if (m?.kind === BlockControlKind.ThemeRequest) {
			this.pushTheme();
			return;
		}
		// Everything else is BP graph traffic — forward to the host router and
		// post the (non-null) response back. The shell re-validates; a malformed
		// / non-dispatchable message resolves to null and nothing is sent. Bridge
		// failures are swallowed (the block degrades to its own rendering).
		const bp = this.opts.services.bp;
		if (!bp) return;
		bp
			.dispatch(this.entityId, payload)
			.then((response) => {
				if (response) this.transport?.send(response);
			})
			.catch(() => {});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.onLoad && this.frame) this.frame.iframe.removeEventListener("load", this.onLoad);
		this.onLoad = null;
		// Close the transport BEFORE destroying the handle so the window listener
		// is gone before the iframe is removed (no in-flight message races a
		// half-torn-down handle) — the ordering the React seam established.
		this.transport?.close();
		this.frame?.destroy();
		this.transport = null;
		this.frame = null;
	}
}

/** Lifetime registry of live embeds, keyed by node id. `renderNode` calls
 *  `acquire` to get (or create) the controller for an Embedded node and
 *  re-parents its persistent container; `paintNodes` calls `reap` after a
 *  repaint to dispose controllers whose node has been deleted. */
export class EmbedMountRegistry {
	private readonly byNode = new Map<string, { ref: string; controller: EmbedMountController }>();

	/** Get-or-create the controller for a node. A changed `entityRef` (the user
	 *  re-pointed the embed at a different entity) disposes the old controller
	 *  and mounts a fresh one. Returns null for a malformed ref. */
	acquire(
		nodeId: string,
		make: () => EmbedMountController | null,
		entityRef: string,
	): EmbedMountController | null {
		const existing = this.byNode.get(nodeId);
		if (existing && existing.ref === entityRef) return existing.controller;
		if (existing) existing.controller.dispose();
		const controller = make();
		if (!controller) {
			this.byNode.delete(nodeId);
			return null;
		}
		this.byNode.set(nodeId, { ref: entityRef, controller });
		return controller;
	}

	/** Dispose every controller whose node id is not in `liveIds`. */
	reap(liveIds: Set<string>): void {
		for (const [nodeId, entry] of this.byNode) {
			if (liveIds.has(nodeId)) continue;
			entry.controller.dispose();
			this.byNode.delete(nodeId);
		}
	}

	/** Fan a theme refresh / vault-change refresh out to every live embed. */
	refreshAllThemes(): void {
		for (const entry of this.byNode.values()) entry.controller.refreshTheme();
	}
	refreshAll(): void {
		for (const entry of this.byNode.values()) entry.controller.refresh();
	}

	/** Dispose everything (board switch / app teardown). */
	disposeAll(): void {
		for (const entry of this.byNode.values()) entry.controller.dispose();
		this.byNode.clear();
	}
}
