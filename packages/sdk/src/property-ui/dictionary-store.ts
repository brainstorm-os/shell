/**
 * DictionaryStore — thin SDK proxy over `bs.services.properties.*`
 * (VP-5). Mirrors `PropertyStore`'s shape; both stores share the
 * single vault-level catalog owned by the shell.
 */

import type { Dictionary } from "@brainstorm-os/sdk-types";

export type DictionaryBackend = {
	setDictionary(dict: Dictionary): Promise<void>;
	removeDictionary(id: string): Promise<void>;
};

type Listener = () => void;

const EMPTY: ReadonlyMap<string, Dictionary> = Object.freeze(new Map());

export type DictionaryStoreOptions = {
	backend: DictionaryBackend;
	onPersistError?: (id: string, error: unknown) => void;
};

export class DictionaryStore {
	private current: ReadonlyMap<string, Dictionary> = EMPTY;
	private readonly listeners = new Set<Listener>();
	private readonly backend: DictionaryBackend;
	private readonly onPersistError: (id: string, error: unknown) => void;
	private loaded = false;
	private disposed = false;

	constructor(opts: DictionaryStoreOptions) {
		this.backend = opts.backend;
		this.onPersistError =
			opts.onPersistError ??
			((id, error) => {
				console.warn(`[notes/dictionary-store] persist failed for ${id}:`, error);
			});
	}

	getSnapshot(): ReadonlyMap<string, Dictionary> {
		return this.current;
	}

	get(id: string): Dictionary | undefined {
		return this.current.get(id);
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

	applySnapshot(map: Readonly<Record<string, Dictionary>>): void {
		if (this.disposed) return;
		this.current = new Map(Object.entries(map));
		this.loaded = true;
		this.emit();
	}

	put(dict: Dictionary): void {
		if (this.disposed) return;
		const previous = this.current;
		const next = new Map(previous);
		next.set(dict.id, dict);
		this.current = next;
		this.emit();
		void this.backend.setDictionary(dict).catch((error) => {
			if (this.disposed) return;
			if (this.current.get(dict.id) === dict) {
				this.current = previous;
				this.emit();
			}
			this.onPersistError(dict.id, error);
		});
	}

	async remove(id: string): Promise<void> {
		if (this.disposed) return;
		const previous = this.current;
		if (!previous.has(id)) return;
		const next = new Map(previous);
		next.delete(id);
		this.current = next;
		this.emit();
		try {
			await this.backend.removeDictionary(id);
		} catch (error) {
			if (this.disposed) return;
			if (this.current === next) {
				this.current = previous;
				this.emit();
			}
			this.onPersistError(id, error);
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
