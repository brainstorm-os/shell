/**
 * Type-level surface for the Graph app's two canonical entity types
 * (`brainstorm/Graph/v1`, `brainstorm/GraphView/v1`) plus the pattern,
 * predicate, view, settings, and history-animation shapes documented in
 *
 *
 * Stage 9.13.1 ships the surface; subsequent iterations (9.13.2+) wire it
 * into the entities service as the service comes online.
 */

export * from "./icon";
export * from "./predicate";
export * from "./pattern";
export * from "./graph";
export * from "./graph-view";
