/**
 * Graph's view of the in-memory vault shape, used by the demo dataset and
 * the pattern matcher's unit tests. The `EntityRow` / `LinkRow` shapes live
 * in `@brainstorm-os/sdk/in-memory-entities` (shared with the Database app);
 * this module re-exports them and names the graph-flavoured snapshot
 * (`InMemoryGraph`).
 */

export type {
	EntityRow,
	LinkRow,
	InMemoryVault as InMemoryGraph,
} from "@brainstorm-os/sdk/in-memory-entities";
