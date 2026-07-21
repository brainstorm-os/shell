# @brainstorm-os/block-protocol

Transport-agnostic [Block Protocol](https://blockprotocol.org) core used by
[Brainstorm](https://getbrainstorm.online): the BP message **envelope**, the
**module router**, and the **hook-module router**. Host bindings (e.g. wiring
the graph module to a data store) live in the embedder, not here — this package
is pure (only `@blockprotocol/core`; no Node or DOM dependencies), so it runs in
any JS runtime.

```sh
npm install @brainstorm-os/block-protocol
```

```ts
import { makeBpRouter, makeBpHookRouter, BpModule } from "@brainstorm-os/block-protocol";

const router = makeBpRouter({ graph: myGraphHandler, hook: makeBpHookRouter() });
const response = await router(ctx, message); // → a properly-shaped BP response envelope, or null
```

Part of the Brainstorm OS. MIT licensed.
