/**
 * React glue around the vault-scoped PropertyStore + DictionaryStore.
 *
 * Pre-VP-5 the provider opened both stores against the Notes-app
 * `storage.kv` namespace. Post-VP-5 it consumes the vault-level
 * catalog through the SDK `properties` service: one `list()` call on
 * mount hydrates both stores; subsequent writes optimistically update
 * the in-memory snapshot and dispatch `setProperty / removeProperty /
 * setDictionary / removeDictionary` through the broker.
 *
 * Topology:
 *   HostApp            <PropertiesProvider runtime={bs} …seams>
 *     editor                ↓ context: { stores, ready, labels, matchers, titleSource }
 *       PropertyBlock           useProperty(key)        →   PropertyDef | undefined
 *       PropertyListBlock       usePropertyStore()      →   ReadonlyMap<string, PropertyDef>
 *         <Cell>                useDictionary(id)       →   Dictionary | undefined
 *
 * The provider takes a structural `runtime` prop (just the properties
 * service) so the subpath never imports back into a host app, and four
 * optional host seams (labels / escape / commit / entityTitleSource);
 * each defaults to a self-sufficient implementation in `./seams`.
 */

import type { Dictionary, PropertiesService, PropertyDef } from "@brainstorm-os/sdk-types";
import {
	type ReactNode,
	createContext,
	useContext,
	useEffect,
	useMemo,
	useSyncExternalStore,
} from "react";
import { DictionaryEditorHost, type DictionaryEditorHostProps } from "./dictionary-editor-host";
import { DictionaryStore } from "./dictionary-store";
import { PropertyStore } from "./property-store";
import {
	type CommitMatcher,
	DEFAULT_DICTIONARY_EDITOR_MATCHERS,
	DEFAULT_PROPERTY_UI_LABELS,
	type DictionaryEditorMatchers,
	EMPTY_ENTITY_TITLE_SOURCE,
	type EntityTitleSource,
	type EscapeMatcher,
	type PropertyUiLabels,
	defaultCommitMatcher,
	defaultEscapeMatcher,
} from "./seams";

/** Structural runtime the provider needs — just the properties service.
 *  Decoupled from any host app's full `window.brainstorm` shape so the
 *  subpath never imports back into an app (a build-failing sdk→app
 *  cycle). */
export type PropertiesRuntime = {
	services: { properties: PropertiesService };
};

export type PropertiesContextValue = {
	propertyStore: PropertyStore;
	dictionaryStore: DictionaryStore;
	ready: boolean;
	labels: PropertyUiLabels;
	escapeMatcher: EscapeMatcher;
	commitMatcher: CommitMatcher;
	entityTitleSource: EntityTitleSource;
	dictionaryEditorMatchers: DictionaryEditorMatchers;
};

/** The host seams alone (no stores) — the return of
 *  `usePropertyUiSeams()`, consumed by every cell + the editor. */
export type PropertyUiSeams = {
	labels: PropertyUiLabels;
	escapeMatcher: EscapeMatcher;
	commitMatcher: CommitMatcher;
	entityTitleSource: EntityTitleSource;
	dictionaryEditorMatchers: DictionaryEditorMatchers;
};

type SeamKeys =
	| "labels"
	| "escapeMatcher"
	| "commitMatcher"
	| "entityTitleSource"
	| "dictionaryEditorMatchers";

/** Exposed so test harnesses can hand-craft stores + ready flag without
 *  building a full mock runtime. Production code should use the
 *  `<PropertiesProvider runtime={…}>` form, which builds the same
 *  context value over the SDK service. Seam fields are optional on the
 *  hand-crafted value — `usePropertyUiSeams()` fills any gaps with the
 *  defaults so a bare `{ propertyStore, dictionaryStore, ready }`
 *  context still drives the cells. */
export const PropertiesContext = createContext<
	(Omit<PropertiesContextValue, SeamKeys> & Partial<Pick<PropertiesContextValue, SeamKeys>>) | null
>(null);

export type PropertiesProviderProps = {
	runtime: PropertiesRuntime;
	children: ReactNode;
	/** Host strings (defaults to English literals matching pre-VP-7). */
	labels?: PropertyUiLabels;
	/** "Is this the cancel chord?" (defaults to a bare `Escape` test). */
	escapeMatcher?: EscapeMatcher;
	/** "Is this the commit chord?" (defaults to a bare `Enter` test). */
	commitMatcher?: CommitMatcher;
	/** Vault title lookup for the Link cell (defaults to empty). */
	entityTitleSource?: EntityTitleSource;
	/** DictionaryEditor chord predicates (defaults to bare keys). */
	dictionaryEditorMatchers?: DictionaryEditorMatchers;
	/** Entity values backing the auto-mounted dictionary editor's usage
	 *  badges + delete/merge rewrites. Omit for read-only counts. */
	dictionaryEntities?: DictionaryEditorHostProps["entities"];
	/** Persist entities whose bound values a delete/merge rewrote. */
	onRewriteDictionaryEntities?: DictionaryEditorHostProps["onRewriteEntities"];
	/** `kv` storage for the dictionary editor's sort-mode preference. */
	dictionarySortStorage?: DictionaryEditorHostProps["storage"];
};

export function PropertiesProvider({
	runtime,
	children,
	labels = DEFAULT_PROPERTY_UI_LABELS,
	escapeMatcher = defaultEscapeMatcher,
	commitMatcher = defaultCommitMatcher,
	entityTitleSource = EMPTY_ENTITY_TITLE_SOURCE,
	dictionaryEditorMatchers = DEFAULT_DICTIONARY_EDITOR_MATCHERS,
	dictionaryEntities,
	onRewriteDictionaryEntities,
	dictionarySortStorage,
}: PropertiesProviderProps) {
	const stores = useMemo(() => {
		const service = runtime.services.properties;
		return {
			propertyStore: new PropertyStore({
				backend: {
					setProperty: (def) => service.setProperty(def),
					removeProperty: (key) => service.removeProperty(key),
				},
			}),
			dictionaryStore: new DictionaryStore({
				backend: {
					setDictionary: (dict) => service.setDictionary(dict),
					removeDictionary: (id) => service.removeDictionary(id),
				},
			}),
		};
	}, [runtime]);

	const ready = useSyncExternalStore(
		(listener) => {
			const a = stores.propertyStore.subscribe(listener);
			const b = stores.dictionaryStore.subscribe(listener);
			return () => {
				a();
				b();
			};
		},
		() => stores.propertyStore.isLoaded() && stores.dictionaryStore.isLoaded(),
	);

	useEffect(() => {
		let cancelled = false;
		const refresh = (): void => {
			const svc = runtime.services?.properties;
			if (!svc || typeof svc.list !== "function") {
				// The exact "properties api not wired to apps" failure: the
				// preload runtime didn't expose the service at all. Logged
				// (captured by the shell error-log) so it's never a silent
				// empty picker again.
				console.error("[property-ui] services.properties.list is unavailable — runtime not wired");
				return;
			}
			void svc
				.list()
				.then((snapshot) => {
					if (cancelled) return;
					const props = snapshot?.properties ?? {};
					const dicts = snapshot?.dictionaries ?? {};
					// Observability: every load outcome is logged at a level
					// the shell error-log captures, so the live result is a
					// deterministic log line (`bun run logs`) instead of a
					// screenshot. Absence of this line ⇒ list() never settled.
					console.warn(
						`[property-ui] catalog loaded: ${Object.keys(props).length} properties, ${Object.keys(dicts).length} dictionaries`,
					);
					// Always apply — an empty catalog is a valid snapshot and
					// must still flip `loaded` so consumers can distinguish
					// "loading" (spinner) from "no properties yet" (empty
					// state) rather than both reading as a blank list.
					stores.propertyStore.applySnapshot(props);
					stores.dictionaryStore.applySnapshot(dicts);
				})
				.catch((error) => {
					if (cancelled) return;
					// Capability denied / no vault / older preload: leave the
					// stores un-loaded so the picker shows its loading state
					// instead of a misleading "no properties" — and surface
					// the cause once for diagnosis.
					console.warn("[property-ui] catalog unavailable:", error);
				});
		};
		refresh();
		// Re-fetch on every shell-side write (Settings → Data, sibling
		// apps, future sync peers). The signal is bare; the snapshot
		// flows through the broker for capability enforcement.
		//
		// Defensive: a dev cycle that rebuilds the app bundle but reuses
		// the running shell will leave the renderer paired with an older
		// preload whose SDK runtime predates `properties.onChange`. We
		// fall back to mount-only refresh in that case so the initial
		// `list()` still lands — without this, calling `undefined`
		// throws from inside `useEffect`, the effect aborts before
		// cleanup is wired, and the user sees an empty property list.
		const onChange = runtime.services.properties.onChange;
		const subscription =
			typeof onChange === "function"
				? onChange.call(runtime.services.properties, refresh)
				: { unsubscribe: () => undefined };
		return () => {
			// Tie ONLY the in-flight fetch + the IPC subscription to this
			// effect. The stores are `useMemo` singletons whose lifetime is
			// the provider's — disposing them here permanently bricked the
			// catalog under React StrictMode: dev double-invokes the effect
			// (run → cleanup → run), the cleanup set `disposed=true` on the
			// singleton stores, `useMemo` never recreated them, and the
			// second run's resolved `list()` hit `applySnapshot`'s
			// `if (this.disposed) return` — so the picker showed
			// "Loading properties…" forever even though list() returned 18
			// properties. `cancelled` already no-ops a post-unmount apply;
			// the stores hold no native handles, so GC reclaims them.
			cancelled = true;
			subscription.unsubscribe();
		};
	}, [runtime, stores]);

	const value = useMemo<PropertiesContextValue>(
		() => ({
			propertyStore: stores.propertyStore,
			dictionaryStore: stores.dictionaryStore,
			ready,
			labels,
			escapeMatcher,
			commitMatcher,
			entityTitleSource,
			dictionaryEditorMatchers,
		}),
		[
			stores,
			ready,
			labels,
			escapeMatcher,
			commitMatcher,
			entityTitleSource,
			dictionaryEditorMatchers,
		],
	);

	return (
		<PropertiesContext.Provider value={value}>
			{children}
			<DictionaryEditorHost
				entities={dictionaryEntities}
				onRewriteEntities={onRewriteDictionaryEntities}
				storage={dictionarySortStorage}
			/>
		</PropertiesContext.Provider>
	);
}

function usePropertiesContext(): PropertiesContextValue {
	const ctx = useContext(PropertiesContext);
	if (!ctx) {
		throw new Error("usePropertiesContext: missing <PropertiesProvider> ancestor");
	}
	// A hand-crafted test context may omit the seam fields; fill any gap
	// with the self-sufficient defaults so the cells render correctly
	// without a Notes runtime.
	return {
		propertyStore: ctx.propertyStore,
		dictionaryStore: ctx.dictionaryStore,
		ready: ctx.ready,
		labels: ctx.labels ?? DEFAULT_PROPERTY_UI_LABELS,
		escapeMatcher: ctx.escapeMatcher ?? defaultEscapeMatcher,
		commitMatcher: ctx.commitMatcher ?? defaultCommitMatcher,
		entityTitleSource: ctx.entityTitleSource ?? EMPTY_ENTITY_TITLE_SOURCE,
		dictionaryEditorMatchers: ctx.dictionaryEditorMatchers ?? DEFAULT_DICTIONARY_EDITOR_MATCHERS,
	};
}

/** The host seams, defaulted. Cells / DictionaryEditor read their
 *  strings + chord predicates + the Link title source from here.
 *
 *  Unlike the store hooks this does NOT require a `<PropertiesProvider>`
 *  ancestor: every seam has a self-sufficient default, so a cell
 *  rendered bare (a unit test, a non-Notes consumer) still gets working
 *  English strings + Escape/Enter matchers + an empty title source. */
export function usePropertyUiSeams(): PropertyUiSeams {
	const ctx = useContext(PropertiesContext);
	return {
		labels: ctx?.labels ?? DEFAULT_PROPERTY_UI_LABELS,
		escapeMatcher: ctx?.escapeMatcher ?? defaultEscapeMatcher,
		commitMatcher: ctx?.commitMatcher ?? defaultCommitMatcher,
		entityTitleSource: ctx?.entityTitleSource ?? EMPTY_ENTITY_TITLE_SOURCE,
		dictionaryEditorMatchers: ctx?.dictionaryEditorMatchers ?? DEFAULT_DICTIONARY_EDITOR_MATCHERS,
	};
}

/** Full vault map + the store. The blocks' `PropertyList` uses this;
 *  single-property cells use the narrower `useProperty(key)`. */
export function usePropertyStore(): {
	store: PropertyStore;
	properties: ReadonlyMap<string, PropertyDef>;
	ready: boolean;
} {
	const { propertyStore, ready } = usePropertiesContext();
	const properties = useSyncExternalStore(
		(listener) => propertyStore.subscribe(listener),
		() => propertyStore.getSnapshot(),
	);
	return { store: propertyStore, properties, ready };
}

/** One PropertyDef, narrowly subscribed. Re-renders only when the
 *  specific key's value reference changes. */
export function useProperty(key: string | null): PropertyDef | undefined {
	const { propertyStore } = usePropertiesContext();
	return useSyncExternalStore(
		(listener) => propertyStore.subscribe(listener),
		() => (key ? propertyStore.get(key) : undefined),
	);
}

export function useDictionaryStore(): {
	store: DictionaryStore;
	dictionaries: ReadonlyMap<string, Dictionary>;
	ready: boolean;
} {
	const { dictionaryStore, ready } = usePropertiesContext();
	const dictionaries = useSyncExternalStore(
		(listener) => dictionaryStore.subscribe(listener),
		() => dictionaryStore.getSnapshot(),
	);
	return { store: dictionaryStore, dictionaries, ready };
}

export function useDictionary(id: string | null): Dictionary | undefined {
	const { dictionaryStore } = usePropertiesContext();
	return useSyncExternalStore(
		(listener) => dictionaryStore.subscribe(listener),
		() => (id ? dictionaryStore.get(id) : undefined),
	);
}
