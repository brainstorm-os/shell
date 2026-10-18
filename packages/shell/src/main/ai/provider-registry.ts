/**
 * In-memory provider registry — maps provider ids to `ModelProvider`s and
 * resolves the configured default when a request pins none. One instance
 * lives for the shell's lifetime. Built-in providers register once at boot;
 * user-added custom endpoints (Agent-14) register and unregister as Settings
 * → AI changes, so the registry also carries each provider's display
 * metadata for `ai.providers()` (doc 22 — provider routing per user
 * configuration).
 */

import type { AiProviderInfo } from "@brainstorm-os/sdk-types";
import type { ModelProvider } from "./provider";

export type ProviderDisplayInfo = Omit<AiProviderInfo, "id">;

export class ProviderRegistry {
	private readonly providers = new Map<string, ModelProvider>();
	private readonly infos = new Map<string, ProviderDisplayInfo>();
	private defaultId: string | null = null;

	/** Register (or replace) a provider; the first registered becomes the
	 *  default unless one is set explicitly. */
	register(provider: ModelProvider, opts?: { default?: boolean; info?: ProviderDisplayInfo }): void {
		this.providers.set(provider.id, provider);
		if (opts?.info) this.infos.set(provider.id, opts.info);
		if (opts?.default || this.defaultId === null) this.defaultId = provider.id;
	}

	/** Remove a provider. Removing the default leaves no default until the
	 *  caller sets one (a request pinning none then fails closed). */
	unregister(id: string): boolean {
		this.infos.delete(id);
		if (this.defaultId === id) this.defaultId = null;
		return this.providers.delete(id);
	}

	setDefault(id: string): void {
		if (this.providers.has(id)) this.defaultId = id;
	}

	/** Resolve a provider by id, or the default when `id` is undefined.
	 *  Returns `null` when nothing usable is configured. */
	get(id: string | undefined): ModelProvider | null {
		if (id !== undefined) return this.providers.get(id) ?? null;
		if (this.defaultId === null) return null;
		return this.providers.get(this.defaultId) ?? null;
	}

	has(id: string): boolean {
		return this.providers.has(id);
	}

	ids(): string[] {
		return [...this.providers.keys()];
	}

	/** Display metadata for every provider registered with `info`. */
	list(): AiProviderInfo[] {
		const out: AiProviderInfo[] = [];
		for (const id of this.providers.keys()) {
			const info = this.infos.get(id);
			if (info) out.push({ id, ...info });
		}
		return out;
	}
}
