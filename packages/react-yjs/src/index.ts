/**
 * @brainstorm-os/react-yjs — React ⇄ Yjs binding (Stage 9.1).
 *
 * The hooks are the only sanctioned way React reads Yjs CRDT state: they
 * batch per microtask and are read-only (mutations flow through the SDK's
 * `entities.update`). `useYDoc(entityId)` resolves through a
 * `<YDocProvider>` the SDK installs at Stage 9.3; `useYDoc(doc)` and the
 * value hooks work today (used by `@brainstorm-os/editor` at 9.2).
 *
 * Pure `*Store` builders + `createYStore` are exported so editors and
 * tests can drive the subscription core without React.
 */

export {
	type UseAwarenessResult,
	useAwareness,
	useBlankRecoveryGap,
	useYDoc,
	useYDocApplyPending,
	useYDocLoaded,
	useYMap,
	useYText,
	useYXmlFragment,
} from "./hooks";
export {
	type YDocHandle,
	type YDocResolver,
	YDocProvider,
	useOptionalYDocResolver,
} from "./provider";
export {
	type YDocResolverApi,
	type YDocTransport,
	REMOTE_ORIGIN,
	createYDocResolver,
} from "./resolver";
export {
	type AwarenessLike,
	type AwarenessSnapshot,
	type AwarenessState,
	awarenessStore,
} from "./awareness";
export {
	type LocalAwareness,
	type PresenceTransport,
	type PresenceHost,
	type PresenceHostPeer,
	createLocalAwareness,
	createSyncedAwareness,
	createPresenceTransport,
	createLoopbackTransports,
	randomClientId,
} from "./synced-awareness";
export {
	yDocStore,
	yMapKeyStore,
	yMapStore,
	yTextStore,
	yXmlFragmentStore,
} from "./stores";
export {
	type YStore,
	type YStoreOptions,
	createYStore,
	shallowMapEquals,
} from "./subscription";
export {
	type QueryStore,
	type QueryStoreOptions,
	createQueryStore,
	shallowArrayEquals,
} from "./query-store";
export {
	type LiveEntitiesSource,
	type UseLiveEntitiesOptions,
	useLiveEntities,
	useVaultEntities,
} from "./query";
export {
	type VaultChangeSource,
	type VaultListStoreOptions,
	EMPTY_VAULT_SNAPSHOT,
	createVaultEntitiesStore,
	createVaultListStore,
	vaultSnapshotEquals,
} from "./vault-entities";
export {
	getUniversalBody,
	isUniversalBodyEmpty,
	universalBodyBlockCount,
	useUniversalBody,
} from "./universal-body";
export {
	type EntitiesDocApi,
	type YDocRemoteBridge,
	type YDocResolverRuntime,
	createYDocResolverAccessor,
	b64ToBytes,
	bytesToB64,
} from "./resolver-accessor";
