# @brainstorm-os/sdk-types

Shared type declarations for the [Brainstorm](https://getbrainstorm.online) app
SDK — the wire contracts, entity/property shapes, and codecs apps and the shell
agree on. The runtime is injected by the shell; this package is types (plus a
few pure codecs/guards) with no heavy dependencies.

```sh
npm install @brainstorm-os/sdk-types
```

```ts
import type { Entity, EntityQuery } from "@brainstorm-os/sdk-types";
```

Part of the Brainstorm OS. MIT licensed.
