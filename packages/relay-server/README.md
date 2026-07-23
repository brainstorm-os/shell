# @brainstorm-os/relay-server

A **blind** WebSocket relay — a tiny forward-only fan-out server for
end-to-end-encrypted apps. Clients subscribe to opaque routing keys; the relay
forwards sealed frames between subscribers **without ever decoding the
payload**. Zero crypto, zero durable storage, zero trust.

It's the transport behind [Brainstorm](https://getbrainstorm.online)'s device
sync, extracted to stand on its own.

```sh
bun add @brainstorm-os/relay-server
```

Runs under [Bun](https://bun.sh) (the CLI uses `Bun.serve`). The routing/audit
core is a plain module and is unit-tested under Node too.

## Why "blind"

The relay only ever reads the **routing header** of a frame — the entity/route
id it fans out on, plus sender + kind for the audit log. Everything after the
header is opaque ciphertext it forwards untouched. There is a structural
invariant enforced in the source: **no crypto, credential, or envelope-seal
imports anywhere in the server path.** A compromised or subpoenaed relay learns
who talked to which channel and when — never *what* was said.

This makes it safe to run a shared relay for many users, or to let users
self-host without trusting the operator.

## Run it

```sh
# from a clone
bun run start -- --port 7780 [--audit-log-path ./relay.jsonl]

# or, once installed as a dependency
bunx brainstorm-relay --port 7780
```

`GET /` returns a health string; everything else upgrades to WebSocket.

## Wire protocol

Binary WebSocket messages, first byte is the channel discriminator:

| Byte   | Channel   | Body                                                        |
| ------ | --------- | ----------------------------------------------------------- |
| `0x00` | Control   | JSON — `subscribe` / `unsubscribe` / `rotate`               |
| `0x01` | Frame     | An opaque E2EE frame; the relay peeks only the routing header |

A frame is laid out as:

```
u32-be(headerLen) || canonicalHeaderBytes
  || u16-be(sigLen=64) || sig
  || u32-be(ctLen)     || ciphertext
```

The relay parses `canonicalHeaderBytes` (a small JSON routing header: version,
kind, `entityId`, sender, seq, nonce, ts, optional `route`), fans the whole
untouched frame out to every other connection subscribed to that key, and never
looks at `sig` or `ciphertext`.

Control messages:

```jsonc
{ "op": "subscribe",   "entityIds": ["<routing-key>", ...] }
{ "op": "unsubscribe", "entityIds": ["<routing-key>", ...] }
{ "op": "rotate",      "from": "<old-key>", "to": "<new-key>" }  // → { "op": "rotated", ... } ack
```

`rotate` is a pure routing move on this storeless relay: subscribers on `from`
are migrated to `to` and the old key is aliased for a grace window, so a client
can rotate its routing token without dropping in-flight frames. The server acks
with `rotated` **last**, so the client only flips emission after the routing
change has landed (fail-closed).

## Programmatic API

The listener is a thin shell around a testable core:

```ts
import { createRelayCore } from "@brainstorm-os/relay-server";

const core = createRelayCore({
  auditSink: (line) => appendToLog(line), // optional; one JSON line per event
});

// Drive the WebSocket handlers directly (this is exactly what bin/relay.ts does):
Bun.serve({
  port: 7780,
  websocket: {
    open(ws) { core.handlers.onOpen(ws); },
    message(ws, msg) { core.handlers.onMessage(ws, msg); },
    close(ws) { core.handlers.onClose(ws); },
  },
  fetch(req, server) {
    return server.upgrade(req) ? undefined : new Response("relay v1");
  },
});
```

`createRelayCore` also exposes `router` (`FrameRouter`) and `audit`
(`AuditLog`) for inspection in tests. The wire helpers `peekRoutingHeader` /
`parseRoutingHeaderJson` and the `WireKind` enum are exported for clients that
need to build or validate frames against the same schema.

## Scope

v1 is deliberately minimal. Operational hardening — auth tokens, TLS
termination, rate limiting, log rotation — is expected to live in front of the
relay (a reverse proxy) or in a later version. The security model does **not**
depend on the relay authenticating anyone: confidentiality and integrity come
from the clients' end-to-end encryption; the relay is just addressed fan-out.

Part of the Brainstorm OS. MIT licensed.
