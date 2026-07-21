# @brainstorm-os/react-yjs

React hooks that bridge [Yjs](https://github.com/yjs/yjs) CRDT state into React —
the reactivity layer behind [Brainstorm](https://getbrainstorm.online). Read a
document's live state with `useYMap` / `useYText` / `useYDoc`, and live entity
lists with `useVaultEntities` / `useLiveEntities`, without hand-rolling a
change loop.

```sh
npm install @brainstorm-os/react-yjs yjs react
```

```tsx
import { useYMap } from "@brainstorm-os/react-yjs";

function Title({ map }) {
  const { title } = useYMap(map);
  return <h1>{title}</h1>;
}
```

`react` and `yjs` are peer dependencies. Part of the Brainstorm OS. MIT licensed.
