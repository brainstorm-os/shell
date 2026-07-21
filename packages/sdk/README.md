# @brainstorm-os/sdk

The [Brainstorm](https://getbrainstorm.online) app SDK: service proxies
marshalled over IPC, shared property/entity helpers, and the reusable React
surfaces (menus, pickers, property UI, virtual lists, editor context rails, …)
every first-party app is built on. Exposed as ~100 focused subpath exports so
apps import only what they use.

```sh
npm install @brainstorm-os/sdk react
```

```ts
import { formatBytes } from "@brainstorm-os/sdk/format-bytes";
import { openObjectMenu } from "@brainstorm-os/sdk/object-menu";
```

`react` is a peer dependency; `@amplitude/unified` is an **optional** peer (only
needed if you use the `./analytics` subpath). CSS surfaces ship as `*.css`
subpath exports. Part of the Brainstorm OS. MIT licensed.
