/**
 * PropertyStore — thin SDK proxy over `bs.services.properties.*` (VP-5).
 *
 * Pre-VP-5 this class wrote PropertyDefs to the Notes-app `storage.kv`
 * namespace at `property:<key>`. Post-VP-5 the authoritative store
 * lives in the shell (vault-level YDoc; see `PropertiesStore` in
 * `packages/shell/src/main/properties/`) and Notes consumes it
 * through the SDK service surface from VP-3. Apps share the catalog;
 * Settings → Data writes from the shell flow through the same path.
 *
 * The public surface (subscribe / getSnapshot / get / put / remove /
 * dispose / isLoaded) stays identical so B5.3's cells + the future
 * B5.4 blocks don't change. What changes is the internals — and the
 * writes are now async + optimistic: `put` / `remove` update the
 * in-memory snapshot synchronously + fire-and-forget the SDK call;
 * on service error the optimistic state is reverted and
 * `onPersistError` fires.
 *
 * Live updates from outside this app (Settings → Data adds a property,
 * Database app adds one in the future) need a push-from-shell channel.
 * Pre-channel callers reload via `applySnapshot()` after their own
 * writes. The provider in `use-properties.tsx` is the central caller.
 */

import type { PropertyDef } from "@brainstorm-os/sdk-types";

/** Narrow slice of the SDK `PropertiesService` the property store needs.
 *  Tests inject a `vi.fn()`-backed fake. */
export type PropertyBackend = {
	setProperty(def: PropertyDef): Promise<void>;
	removeProperty(key: string): Promise<void>;
};

type Listener = () => void;

const EMPTY: ReadonlyMap<string, PropertyDef> = Object.freeze(new Map());

export type PropertyStoreOptions = {
	backend: PropertyBackend;
	/** Receives any per-key persistence error. Defaults to a console
	 *  warn so user code stays quiet; tests inject a spy. */
	onPersistError?: (key: string, error: unknown) => void;
};

export class PropertyStore {
	private current: ReadonlyMap<string, PropertyDef> = EMPTY;
	private readonly listeners = new Set<Listener>();
	private readonly backend: PropertyBackend;
	private readonly onPersistError: (key: string, error: unknown) => void;
	private loaded = false;
	private disposed = false;

	constructor(opts: PropertyStoreOptions) {
		this.backend = opts.backend;
		this.onPersistError =
			opts.onPersistError ??
			((key, error) => {
				console.warn(`[notes/property-store] persist failed for ${key}:`, error);
			});
	}

	getSnapshot(): ReadonlyMap<string, PropertyDef> {
		return this.current;
	}

	get(key: string): PropertyDef | undefined {
		return this.current.get(key);
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	isLoaded(): boolean {
		return this.loaded;
	}

	/** Replace the in-memory map with the latest snapshot from the shell.
	 *  The provider calls this once on mount (after the runtime's
	 *  `properties.list()` resolves) and again whenever a future
	 *  `properties:snapshot` push channel delivers an update. */
	applySnapshot(map: Readonly<Record<string, PropertyDef>>): void {
		if (this.disposed) return;
		this.current = new Map(Object.entries(map));
		this.loaded = true;
		this.emit();
	}

	/** Optimistic write. Updates the snapshot synchronously + notifies
	 *  listeners, then dispatches to the SDK service. On service error
	 *  the previous snapshot is restored and `onPersistError` fires. */
	put(def: PropertyDef): void {
		if (this.disposed) return;
		const previous = this.current;
		const next = new Map(previous);
		next.set(def.key, def);
		this.current = next;
		this.emit();
		void this.backend.setProperty(def).catch((error) => {
			if (this.disposed) return;
			// Only revert if our optimistic entry is still present; a later
			// successful write (or external snapshot) may have moved on.
			if (this.current.get(def.key) === def) {
				this.current = previous;
				this.emit();
			}
			this.onPersistError(def.key, error);
		});
	}

	/** Optimistic delete. Same shape as `put`: pull the entry out + emit;
	 *  on service error, restore it. Resolves after the underlying SDK
	 *  call settles so callers can wait before unmounting popovers. */
	async remove(key: string): Promise<void> {
		if (this.disposed) return;
		const previous = this.current;
		if (!previous.has(key)) return;
		const next = new Map(previous);
		next.delete(key);
		this.current = next;
		this.emit();
		try {
			await this.backend.removeProperty(key);
		} catch (error) {
			if (this.disposed) return;
			// Restore only if the snapshot hasn't moved on since.
			if (this.current === next) {
				this.current = previous;
				this.emit();
			}
			this.onPersistError(key, error);
		}
	}

	dispose(): void {
		this.disposed = true;
		this.listeners.clear();
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}
