# Real-time client↔server sync for Vinnodrive v2

**Question (wayfinder #4):** What client↔server sync architecture gives a collaborative planning workspace live updates — and a path to offline support later — on per-space Durable Objects (celld cells)?

**Method:** primary sources only — celld docs/source/issues, Cloudflare Workers/Durable Objects docs, protocol specs, and first-party project docs/repos (Linear, Actual Budget, Liveblocks, PartyKit, Jazz, Replicache, Yjs, Automerge). All sources accessed **2026-10-04**. Estimates are labelled.

> Location note: wayfinder #4 nominally outputs `docs/research/realtime-sync.md` on a `research/realtime-sync` branch. This session was instructed to write to `.scratch/research/realtime-sync.md` and to run no git/gh commands, so that is where it lives.

---

## TL;DR

**Recommended: a server-sequenced per-space op log, streamed over hibernatable WebSockets, with materialized SQLite state and snapshot-plus-tail catch-up. Keep CRDTs (Yjs) as an escape hatch scoped to rich text/descriptions, not as the whole data model.**

- One cell per space. The cell is the single writer: it assigns a monotonic `seq` to every mutation in a synchronous SQLite turn, appends an op row, updates materialized tables, and broadcasts the op to connected clients ([Linear's ordered sync-action log](https://linear.app/now/rebuilding-delta-sync-read-path), [Liveblocks' single ordered server point](https://liveblocks.io/docs/guides/how-conflict-resolution-works-in-liveblocks-sync), [Replicache push/pull](https://doc.replicache.dev/concepts/how-it-works)).
- Hibernatable WebSockets are the primary transport ([celld supports them](https://celld.dev/docs/services/durable-objects); [Cloudflare recommends them](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)). Reconnect is a first-class protocol: client sends `lastSeq`, server streams `ops > lastSeq`, or a `snapshot + tail` when the gap exceeds retention.
- SSE is a read-only fallback with the same `seq`-as-event-id framing; writes go over authenticated HTTP with idempotency keys. celld's **60 s inactive stream rule** makes heartbeats mandatory ([celld compat](https://celld.dev/docs/cloudflare-compat)).
- Offline later is the same protocol plus a client outbox and snapshot store (Replicache's mutator/rebase model, [doc.replicache.dev](https://doc.replicache.dev/concepts/how-it-works)); nothing in the wire protocol changes.
- Planning data is mostly last-write-wins per field, which is exactly what Liveblocks/Linear/Jazz do; CRDTs' merge strengths matter most for collaborative text, so scope Yjs there ([Yjs updates are idempotent/commutative](https://docs.yjs.dev/api/document-updates); [Liveblocks uses server-ordered LWW/CRDT-like types](https://liveblocks.io/docs/guides/how-conflict-resolution-works-in-liveblocks-sync)).

---

## 1. Substrate constraints that shape the design

### 1.1 The cell is the right unit of coordination

Cloudflare's own guidance is to model each Durable Object around the "atom of coordination" — a chat room, document, or tenant workspace — with deterministic IDs and parent/child sharding; a single global DO is explicitly the anti-pattern ([Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)). celld frames the same model: "a collaborative document is one cell. The cell holds the WebSocket connections and the state of one room, so the room needs no lock and no external message bus" ([celld overview](https://celld.dev/docs)). A space (list/board + its tasks) is the natural cell; a small directory cell holds user/space indexes.

Throughput ceiling per cell, for sizing:

| Source | Number |
|---|---|
| Cloudflare rules-of-DO | ~500–1,000 req/s simple ops; ~200–500 req/s with transformation/storage writes |
| celld | `CELLD_MAX_CELL_REQUESTS=64` concurrent fetch events; 503 above |
| Cloudflare DO limits FAQ | soft limit ~1,000 req/s per object |

Sources: [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/), [celld overview](https://celld.dev/docs), [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/). A household/team workspace is orders of magnitude below these; the ceiling matters only if a space DO is made hot by high-frequency presence/cursor traffic — batch or throttle that.

### 1.2 WebSockets on celld

**Hibernation and lifetime.**

- Hibernatable sockets are accepted with `ctx.acceptWebSocket()`; incoming messages call `webSocketMessage` and the object is re-initialized (constructor runs) on wake ([Cloudflare hibernation docs](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [DurableObjectState](https://developers.cloudflare.com/durable-objects/api/state/)).
- On celld, "a hibernatable WebSocket survives a hibernation on the same node, and it closes when the cell moves to a new owner, so a client must reconnect" ([celld DOs](https://celld.dev/docs/services/durable-objects)). Rebalancing closes hibernatable sockets with **code 1012** ("so the clients reconnect to the new owner") and celld states the rule plainly: "A WebSocket transport cannot move to a new cell owner. A client must reconnect with the same application operation ID." ([celld overview](https://celld.dev/docs), [celld compat](https://celld.dev/docs/cloudflare-compat)).
- Deploys: a resident object moves at a safe point and **keeps its hibernatable WebSockets**; if no safe point is reached in `CELLD_DEPLOY_MAX_AGE_S` (default 60 s), celld forces the move and closes *regular* WebSockets with 1012 ([celld overview](https://celld.dev/docs)). Cloudflare itself disconnects all WebSockets on code deploy ([hibernation docs](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).
- Reconnect economics: design every client to treat close as normal, reconnect with exponential backoff + jitter, and resume by sequence. y-websocket is a good reference implementation: exponential backoff capped at 2.5 s, with a convention that close codes 4400–4499 are permanent and 4500–4599 transient ([y-websocket](https://github.com/yjs/y-websocket)).

**Frames and limits.**

- The hard Cloudflare receive limit is 32 MiB per WebSocket message, over which the socket closes with code 1009 ([Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/), [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)).
- celld is stricter: "Each isolate-polled input queue has a 1 MiB budget for non-terminal frames. A message larger than 1 MiB uses the complete budget." ([celld compat](https://celld.dev/docs/cloudflare-compat)). Practical rule: keep every inbound logical message well under 1 MiB (target ≤256 KiB) and chunk catch-up streams; never send a giant snapshot or Yjs update as one frame.
- Outbound Worker sockets do not stay open past their event: "An outbound Worker socket closes when its event and `waitUntil` work end. A socket returned in the response stays open." ([celld compat](https://celld.dev/docs/cloudflare-compat)). Server-accepted sockets returned in the upgrade response are the supported pattern.
- Frame ordering and the output gate: celld holds a response/frame until a durability proof covers the writes it can reveal; "a hibernatable socket delivers the frames in send order across WebSocket handlers and RPC methods, even when the output gate delays an earlier frame" ([celld DOs](https://celld.dev/docs/services/durable-objects)). So per-socket order is guaranteed, but latency before delivery tracks celld's durability proof (≈90 ms single node / ~25 ms with a follower per [celld substrate findings](https://github.com/Siddhj2206/Vinnodrive/blob/research/celld-substrate/docs/research/celld-substrate.md)).
- Connection capacity: Cloudflare allows 32,768 hibernatable sockets per DO ([DurableObjectState](https://developers.cloudflare.com/durable-objects/api/state/)); celld does not document a socket cap, but its 128 MB isolate heap is the practical limit: "approximately 50,000 at the default, and approximately 512 MB for 100,000" connections, and an isolate above 90% heap refuses a new hibernatable WebSocket ([celld README](https://github.com/denoland/celld/blob/main/README.md)). Per-connection attachments (user id, session) persist through hibernation; Cloudflare caps a serialized attachment at 16,384 bytes ([hibernation docs](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).
- Keepalive: Cloudflare answers protocol pings automatically without waking the object and does not call `webSocketMessage` for control frames ([hibernation docs](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)). Application-level presence heartbeats should be batched (Cloudflare advises batching 10–100 logical messages per frame, every 50–100 ms) ([same](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).

### 1.3 HTTP streams and SSE: the 60 s rule

celld supports `EventSource` and streaming responses ("EventSource: Yes" in [celld compat](https://celld.dev/docs/cloudflare-compat)), but two celld-specific rules matter:

- "celld expires an unclaimed and inactive HTTP stream after 60 seconds. A successful stream operation starts a new 60-second period." and "An expired or unknown stream reports an error instead of EOF." ([celld compat](https://celld.dev/docs/cloudflare-compat)). So an SSE server must write something (heartbeat comment) **well inside 60 s**, and clients must treat stream errors/closures as reconnects — not wait for a clean EOF.
- The output gate applies to streamed responses as it does to any response: celld "holds a response until a durability proof covers every write that the response can reveal" ([celld DOs](https://celld.dev/docs/services/durable-objects)). In practice, live SSE events are released after the same durability proof that gates WebSocket frames; this is fine for ops (they are already durable) but argues against mixing un-durable transient state into the stream.

Client-side SSE semantics come free from the HTML spec: automatic reconnection, `Last-Event-ID` sent on reconnect, server-settable `retry` delay, and the authoring advice to write a comment line every ~15 s to survive proxy timeouts ([HTML Standard, server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)). Cloudflare Workers impose no hard duration limit on HTTP responses while the client stays connected ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)), so SSE works on both runtimes; only celld adds the 60 s inactivity expiry.

### 1.4 Storage, ordering, and alarms

- Each cell has a private SQLite database; SQL is synchronous within an event turn, and celld states "Inside the cell, one synchronous turn runs at a time. An event that awaits can overlap another event unless `blockConcurrencyWhile()` closes the input gate" ([celld DOs](https://celld.dev/docs/services/durable-objects)). Cloudflare's input/output gates make ordinary read-modify-write code safe when it stays in storage operations, and writes without intervening awaits are coalesced atomically ([Durable Objects: Easy, Fast, Correct](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/), [Rules of DOs](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)).
- **celld-specific warning:** on one socket it "starts the message handlers in arrival order, but it does not wait for a handler to finish before starting the next handler. Therefore an incoming message can cancel work that an earlier handler awaits" ([celld DOs](https://celld.dev/docs/services/durable-objects)). Design mutation handlers to do all authoritative work in one synchronous SQLite block (or `transactionSync`), then queue the broadcast; don't hold correctness in per-handler memory across an `await`.
- Alarms are at-least-once with automatic retries (Cloudflare: up to 6 retries, exponential backoff from 2 s; celld: one alarm per object, durable wake entry written before the client sees success) — so compaction/pruning jobs must be idempotent ([Cloudflare Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [celld DOs](https://celld.dev/docs/services/durable-objects)). Note celld has an open bug where alarm handlers can overlap ([celld #144](https://github.com/denoland/celld/issues/144)) — a reason to make compaction itself idempotent and re-entrant, and to guard with SQL state rather than in-memory flags.
- Transactions and `blockConcurrencyWhile` have a 30 s limit in celld; `storage.sync()` uses the shorter of 10 s and 15 s deadlines ([celld DOs](https://celld.dev/docs/services/durable-objects)). Keep compaction batches small.

### 1.5 What actually differs from Cloudflare (the celld gaps that bite sync)

| Concern | Cloudflare | celld |
|---|---|---|
| Inbound WS message | 32 MiB, else close 1009 | **1 MiB input-queue budget for non-terminal frames**; a bigger message consumes the whole budget ([compat](https://celld.dev/docs/cloudflare-compat)) |
| WS on restart/move | Hibernation survives; deploy disconnects all | Hibernation survives **same-node** hibernate; **close 1012 on owner move**; reconnect required ([DOs](https://celld.dev/docs/services/durable-objects)) |
| Long-lived streams | No HTTP duration limit | **60 s inactive stream expiry**; expiry is an error, not EOF ([compat](https://celld.dev/docs/cloudflare-compat)) |
| Point-in-time restore | 30 days on SQLite DOs ([storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)) | **Unsupported** ([celld #125](https://github.com/denoland/celld/issues/125)) |
| Storage cap per cell | 10 GB paid / 1 GB free ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/)) | Undocumented; practical cliffs at **80 MiB/10 s handoff snapshot** and **256 MiB paged restore** ([overview](https://celld.dev/docs)) |
| BroadcastChannel | Supported | Constructor **throws** ([compat](https://celld.dev/docs/cloudflare-compat)) — matters for multi-tab sync |
| Placement | Global, automatic | No placement/migration promise; single node owns a cell ([DOs](https://celld.dev/docs/services/durable-objects)) |

---

## 2. Protocol patterns

### 2.1 Server-sequenced op log + catch-up (the recommendation)

The pattern that recurs across production planning/collab tools:

- **Linear** keeps, per workspace, "its own immutable ordered sync action log where new sync actions are appended"; each action has an ordered ID, the affected model, change type, routing metadata, and the data the client must apply. Clients keep a checkpoint (last applied action ID) and request the delta — "each client maintains a local database... a client returning online needs a way to catch up, *fast*" ([Rebuilding Linear's delta sync read path](https://linear.app/now/rebuilding-delta-sync-read-path)).
- **Liveblocks** applies every room's changes "one after another, in the order they arrive" at a single server point; clients apply optimistically and queue pending changes until confirmed ([conflict resolution guide](https://liveblocks.io/docs/guides/how-conflict-resolution-works-in-liveblocks-sync)).
- **Actual Budget** syncs per-field messages stamped with a hybrid logical clock, and uses a Merkle trie to find divergence, exchanging only messages after it: `SyncRequest{messages, fileId, groupId, since}`, `SyncResponse{messages, merkle}` ([sync.proto](https://github.com/actualbudget/actual/blob/master/packages/crdt/src/proto/sync.proto), [timestamp.ts](https://github.com/actualbudget/actual/blob/master/packages/crdt/src/crdt/timestamp.ts), [merkle.ts](https://github.com/actualbudget/actual/blob/master/packages/crdt/src/crdt/merkle.ts)).
- **Replicache** generalizes it: mutations carry sequential IDs; push executes them on the server; pull returns a patch plus `lastMutationID`; the client rebases pending mutations on the new state ([how it works](https://doc.replicache.dev/concepts/how-it-works)).
- **Yjs** provides the binary equivalent for CRDT state: clients exchange state vectors, then only the missing updates (`SyncStep1`/`SyncStep2`), and updates are commutative, associative, and idempotent ([document updates](https://docs.yjs.dev/api/document-updates), [y-protocols](https://github.com/yjs/y-protocols)).

For a planning workspace the server-sequenced variant is the smaller, more controllable machine: the server is the only writer of `seq`, so the log is total-ordered by construction, no clocks are needed, and catch-up is a range query. Actual's HLC + Merkle machinery exists because Actual is multi-master (any device may push); Vinnodrive's server owns each space, so HLC is not needed at v1.

### 2.2 CRDTs: Yjs and Automerge — where they fit

**Yjs**

- Each insert gets a Lamport `(clientID, clock)`; deletes are state-based and carry no metadata; with GC on, deleted content is replaced by a lightweight `GC` struct holding only the length; a snapshot is a state vector + delete set, and the B4 editing trace (182k inserts, 77k deleted chars) produces a **4.5 KB** delete set ([INTERNALS.md](https://github.com/yjs/yjs/blob/main/INTERNALS.md)).
- Updates are "commutative, associative, and idempotent... apply them in any order and multiple times"; catch-up uses state vectors; `Y.mergeUpdates` can compact updates without loading the document, but "only merges document updates and doesn't garbage-collect deleted content. You still need to load the document to a `Y.Doc` to reduce the document size." ([document updates](https://docs.yjs.dev/api/document-updates)). `doc.gc` is the switch for tombstone content collection ([Y.Doc API](https://docs.yjs.dev/api/y.doc)).
- Server-side: y-websocket is a classical client/server provider: clients connect to one endpoint, the server fans out updates and awareness; the simple server persists to databases (LevelDB) and cannot scale easily, while `@y/hub` targets scale/auth ([y-websocket](https://github.com/yjs/y-websocket)). Mapping one Y.Doc per space cell is straightforward, but so is one Y.Doc per text field.

**Automerge**

- Its sync protocol is based on [arXiv:2012.00472](https://arxiv.org/abs/2012.00472) and "assumes a reliable in-order stream between two peers"; each peer keeps a `State`, sends `Have` (with a Bloom filter) to describe what it already has, and `generate_sync_message`/`receive_sync_message` until quiet ([automerge::sync](https://automerge.org/automerge/automerge/sync/index.html)). A WebSocket is exactly such a stream, and `automerge-repo` supplies storage adapters (IndexedDB) and a WebSocket network adapter ([repositories](https://automerge.org/docs/reference/repositories)).
- Automerge's document/change model is a good fit when you want multi-master convergence without a server sequence; the cost is that a space's state is a document with its own storage/compaction concerns, and server-side per-field queries/validation are harder than SQL.

**Verdict for Vinnodrive:** use CRDTs only where merge quality beats server ordering (rich text: task descriptions, comments). Keep ordinary task/list state as server-sequenced ops. That mirrors Liveblocks' own split (server-ordered LWW for structure, merge for `LiveText`) ([conflict resolution](https://liveblocks.io/docs/guides/how-conflict-resolution-works-in-liveblocks-sync)) and avoids CRDT log/compaction complexity for data that rarely conflicts.

### 2.3 Presence and cursors

Presence is ephemeral and should never live in the durable op log:

- Yjs awareness keeps one `Map<clientID, state>` per client, drops a client whose state wasn't refreshed for **30 s**, and is propagated but not persisted ([y-protocols](https://github.com/yjs/y-protocols)); awareness updates are separate from document updates and have their own `modifyAwarenessUpdate` hook for servers to enforce identity.
- Liveblocks separates `Presence` (temporary) from `Storage` (persistent) explicitly ([storage docs](https://liveblocks.io/docs/products/sync/storage)), and renders cursors/avatars from presence.
- In a cell, presence can be in-memory plus WebSocket attachments for identity; hibernation drops in-memory presence, so clients re-announce on reconnect/heartbeat. Presence messages are the highest-frequency traffic — batch them (Cloudflare's 50–100 ms batching advice) and throttle cursor moves.

### 2.4 Optimistic updates and reconciliation

Three workable models, all applicable:

- **Replicache (mutators + rebase):** a mutator applies locally, is queued as a mutation (sequential per client), pushed to the server, executed there, and confirmed via `lastMutationID`; after each pull the client rewinds to the last server state, applies the patch, and replays pending mutations — the server's confirmed state wins, and mutators contain the app-specific conflict logic ([how it works](https://doc.replicache.dev/concepts/how-it-works)).
- **Liveblocks (pending hold-back):** local change applies immediately and is queued pending; while it is pending, Liveblocks "can hold back other people's changes to that same value, so it doesn't briefly flip to their value and then back to yours" ([conflict resolution](https://liveblocks.io/docs/guides/how-conflict-resolution-works-in-liveblocks-sync)).
- **CRDT (no reconciliation):** with Yjs, local and remote updates simply merge, and reconnection replay is idempotent ([document updates](https://docs.yjs.dev/api/document-updates)); the "reconciliation" is the CRDT itself.

For the server-sequenced design, adopt Replicache's shape: client-generated **mutation IDs**, server dedupe by `(clientId, mutationId)`, client rebase after each reconnect/pull. Conflict policy for planning fields: LWW per field, decided by the server's apply order (Liveblocks' rule: "the last change to reach the server wins, per key"), and append-only for comments/history ([Liveblocks](https://liveblocks.io/docs/guides/how-conflict-resolution-works-in-liveblocks-sync)).

### 2.5 Compaction and snapshots of op logs

An op log is a change feed, not the database:

- Keep materialized state tables (tasks, lists, members) and append the op **in the same SQLite transaction**. Then a snapshot needs no assembly pass — it is the materialized state at `snapshotSeq`.
- Retain a tail of ops for cheap catch-up and delete older ones on a schedule. Clients whose `lastSeq` falls behind the retained tail get `snapshot + tail`. Linear's design shows the shape: "Postgres is the right place to commit and retain our client-facing WAL"; the reconnect query is an ID range filtered by access and subscriptions, with the authoritative head served from the source of truth and the historical range from an index ([delta sync](https://linear.app/now/rebuilding-delta-sync-read-path)).
- For CRDT documents, compaction means re-encoding through the library: Yjs's `mergeUpdates` cannot GC; you must load and re-encode ([document updates](https://docs.yjs.dev/api/document-updates)).
- celld adds two hard constraints: there is **no PITR** ([#125](https://github.com/denoland/celld/issues/125)) and epoch retention is **off by default** (`CELLD_LTX_RETENTION_SECS` unset or 0 means "celld deletes no epoch prefix", so bucket bytes grow with activations) ([celld overview](https://celld.dev/docs)). Log retention and epoch GC are therefore application/operator responsibilities, not platform features.

---

## 3. Prior art and what transfers to celld

| System | Core mechanism | Source | What transfers, what doesn't |
|---|---|---|---|
| **Linear** | Per-workspace immutable ordered sync-action log; client checkpoint + delta; permission/subscription filtering; ~1M actions/day for largest workspaces, 20 TB total | [delta sync](https://linear.app/now/rebuilding-delta-sync-read-path), [talk](https://linear.app/blog/scaling-the-linear-sync-engine) | Log + checkpoint + filtered delta is exactly the Vinnodrive protocol. Ignore the Turbopuffer scale engineering; SQLite range queries on a cell do this trivially. |
| **Actual Budget** | Field-level messages + HLC (5 min drift allowance) + Merkle trie; `since` / `merkle` in proto; LWW | [proto](https://github.com/actualbudget/actual/blob/master/packages/crdt/src/proto/sync.proto), [timestamp.ts](https://github.com/actualbudget/actual/blob/master/packages/crdt/src/crdt/timestamp.ts), [merkle.ts](https://github.com/actualbudget/actual/blob/master/packages/crdt/src/crdt/merkle.ts) | Field-level ops, protobuf envelopes, E2EE-ready envelope (`EncryptedData`), "since" catch-up. Merkle+HLC are only worth it for multi-master/offline-first from day one; merkle pruning is lossy and can need repeated passes (see the TODO comments in `merkle.ts`). |
| **Cloudflare chat demo** | One DO per room; WebSockets broadcast; history in durable storage but real-time messages relayed directly; rate-limit DO with no storage | [workers-chat-demo](https://github.com/cloudflare/workers-chat-demo) | Broadcast to hibernated sockets is the right transport pattern. But note it relays messages *outside* storage: Vinnodrive should append the op first (durability + webhooks), then broadcast — the output gate makes that safe. |
| **Liveblocks** | Server-ordered updates per room; LWW per key; list inserts both kept and server-ordered; optimistic + pending hold-back; version-history snapshots | [conflict resolution](https://liveblocks.io/docs/guides/how-conflict-resolution-works-in-liveblocks-sync), [Sync product](https://liveblocks.io/docs/products/sync) | The data-type semantics to copy for planning: per-key LWW, additive lists, ephemeral presence. Vendor comparison to Yjs claims "no tombstone growth" ([liveblocks.io/sync](https://liveblocks.io/sync)) — a fair reminder to bound CRDT use. |
| **PartyKit** | "Each PartyKit server... is backed by a Cloudflare Durable Object"; id routes to the same room; state as class properties; WebSocket and HTTP | [how it works](https://docs.partykit.io/how-partykit-works/) | The one-DO-per-room + in-memory state + `broadcast` ergonomics are the same shape celld gives you. PartyKit's hibernation-aware server API and its Yjs API (`y-partykit`) are references for framing/batching ([docs index](https://docs.partykit.io/)). |
| **Jazz** | Local replica + background sync; writes apply locally and queue row versions; three tiers (local/edge/global); LWW per field; tab leader; self-host sync server persists to SQLite | [How Sync Works](https://jazz.tools/docs/concepts/how-sync-works), [sync & storage (classic)](https://classic.jazz.tools/docs/vanilla/core-concepts/sync-and-storage) | Confirms the "local durable copy + queued writes + LWW" offline model. Its multi-tier edge/global mesh is unnecessary for single-node celld. |
| **Replicache** | Mutators, mutation IDs, push/pull, `lastMutationID`, rebase; poke via WS or SSE | [how it works](https://doc.replicache.dev/concepts/how-it-works) | The optimistic/offline protocol to imitate — client outbox, idempotent server apply, rebase, contentless "poke" that only tells clients to pull. |
| **Yjs / Automerge** | Idempotent updates + state vectors; or change-based sync with `Have`/Bloom | [Yjs updates](https://docs.yjs.dev/api/document-updates), [Automerge sync](https://automerge.org/automerge/automerge/sync/index.html) | Use for text/rich comments. One Y.Doc per text field, binary updates stored as a sub-stream in the cell; compact with the library. |

---

## 4. Data volumes

### 4.1 Documented limits

| Limit | Value | Source |
|---|---|---|
| Storage per SQLite DO (Cloudflare) | 10 GB paid / 1 GB free; 5 GB total free | [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| String/BLOB/row size | 2 MB | [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| SQL statement / bound params / columns | 100 KB / 100 / 100 | [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| WS message (received) | 32 MiB (CF), ~1 MiB effective (celld input budget) | [Workers WS](https://developers.cloudflare.com/workers/runtime-apis/websockets/), [celld compat](https://celld.dev/docs/cloudflare-compat) |
| CPU per request | 30 s default, up to 5 min configurable | [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| Isolate heap | 128 MB (celld configurable; ~50k WS at default) | [celld README](https://github.com/denoland/celld/blob/main/README.md) |
| celld handoff snapshot | ~80 MiB at the default 10 s deadline; larger DBs hand off via the L0 chain | [celld overview](https://celld.dev/docs) |
| celld paged restore | Pages instead of clones from 256 MiB (`CELLD_LTX_PAGED_MIN_MB`); hydrates at 16 MiB/s; page faults block the JS turn | [celld overview](https://celld.dev/docs) |
| celld cell density | 1,000 resident cells per 8 GB node (docs; the landing page claims 2,500) | [celld overview](https://celld.dev/docs), [substrate findings](https://github.com/Siddhj2206/Vinnodrive/blob/research/celld-substrate/docs/research/celld-substrate.md) |

**Architecture-relevant reading:** keep a space cell comfortably under the 256 MiB paging threshold, and ideally under the 80 MiB handoff budget — a paged restore reads pages from the bucket synchronously inside a JS turn, so "a query that reads many such pages can therefore take minutes" ([celld overview](https://celld.dev/docs)). For a single-node household/team install, a space DB of a few MB to a few tens of MB is normal and keeps restarts/upgrades boring.

### 4.2 What an op log costs at planning-workspace scale (estimate)

An op row is small: `seq INTEGER PRIMARY KEY`, `actor`, `timestamp`, `kind`, task/list id, field, value/JSON payload. For a JSON payload plus indexes, **~150–400 bytes per op** is a fair planning number (this is an estimate, not a documented figure; the only hard data points are SQLite's 2 MB row cap and the DO limits above). Scale it:

- 10 users × 100 actions/day = **1,000 ops/day ≈ 0.15–0.4 MB/day ≈ 55–146 MB/year**.
- 10 users × 1,000 actions/day (heavy automation/import) = **10,000 ops/day ≈ 1.5–4 MB/day ≈ 0.5–1.5 GB/year**.
- Compare with Linear: largest workspaces produce "close to one million sync actions per day" ([delta sync](https://linear.app/now/rebuilding-delta-sync-read-path)) — that is the scale Vinnodrive is *not* at, but it shows the retention problem is real at every order of magnitude.

Consequences:

- Keep ops indefinitely only if the DB stays far below the paging cliff. At 1,000 ops/day you cross 80 MiB in roughly **7–18 months**; at 10,000 ops/day in **3–4 weeks** (estimate). Either way, a retention policy is required, not optional.
- Materialized state stays tiny (a few hundred KB for thousands of tasks), so `snapshot + ops tail` catch-up is cheap.
- Files/attachments must never be op payloads: metadata op only, bytes in R2 ([celld R2 docs](https://celld.dev/docs/services/r2), [substrate findings](https://github.com/Siddhj2206/Vinnodrive/blob/research/celld-substrate/docs/research/celld-substrate.md)).

### 4.3 When snapshots are needed

Make the trigger explicit and cheap:

1. **Continuously:** write materialized tables in the same transaction as the op, so current state is always a valid snapshot at `snapshotSeq = latest seq`.
2. **On a schedule (alarm):** prune ops older than a retention window (e.g., keep `max(30 days, last 50k ops)` — tune). Record `oldest_retained_seq`. The alarm is idempotent because pruning is a delete by range.
3. **On demand:** if a client's `lastSeq < oldest_retained_seq`, send a snapshot frame (materialized state + `snapshotSeq`) and then the tail. This is the Linear checkpoint semantics in miniature.
4. **For CRDT text fields:** periodically load the Y.Doc and re-encode (`Y.encodeStateAsUpdate`, GC on) to collapse tombstones; store a compacted update and forward updates after it ([Yjs](https://docs.yjs.dev/api/document-updates), [INTERNALS](https://github.com/yjs/yjs/blob/main/INTERNALS.md)).

Open verification: deleting rows does not necessarily shrink a SQLite file; whether celld's DO SQLite allows `VACUUM`/`auto_vacuum` is not documented in the celld pages reviewed. Test before relying on space reclamation (see Open questions).

---

## 5. Recommended design for Vinnodrive v2

### 5.1 Topology

- `SpaceCell` (one per space, `idFromName("space:" + spaceId)`): owns the op log, materialized tables, presence, and sockets. One cell = one space = one writer.
- `DirectoryCell` (KV/D1): user, membership, space index, invite/share tokens. Keep it out of the hot path; it is a single writer by design, acceptable at household/team scale ([Rules of DOs](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)).
- Auth happens in the stateless Worker before upgrading to the DO; celld provides no auth and its public listener is meant to sit behind a TLS/auth proxy ([celld security](https://celld.dev/docs/security), [substrate findings](https://github.com/Siddhj2206/Vinnodrive/blob/research/celld-substrate/docs/research/celld-substrate.md)). Validate membership again inside the DO per connection and per mutation.

### 5.2 Wire protocol (v1, WebSocket)

Message types (small JSON envelopes to start; binary later if profiling demands):

```
client→server: hello    { clientId, lastSeq, protocol }
client→server: mutation { clientId, mutationId, kind, payload }   // optimistic, idempotent
client→server: presence { state }                                  // ephemeral
server→client: snapshot { snapshotSeq, state }                     // only when gap > retention
server→client: ops      { ops: [{ seq, ... }] }                    // chunked, ≤ ~256 KiB/frame
server→client: ack      { mutationId, seq }                        // durability already proven
server→client: reject   { mutationId, reason }                     // validation/permission failure
server→client: presence { clientId, state }
server→client: ping     { t }                                      // optional app-level liveness
```

Server apply path (all in one synchronous turn / `transactionSync`):

1. Dedupe `(clientId, mutationId)` in a `mutations` table (keep a bounded recent window).
2. Validate against SQLite state and permissions.
3. `INSERT INTO ops(...)`; SQLite assigns `seq` (AUTOINCREMENT).
4. Update materialized tables in the same transaction.
5. Ack the sender (output gate releases it only after durability) and broadcast `ops` to other sockets in send order ([celld DOs](https://celld.dev/docs/services/durable-objects)).

Client apply path:

- Apply ops idempotently: ignore `seq <= lastSeq`; persist `lastSeq` locally.
- On local mutation: apply optimistically, enqueue in the outbox with `mutationId`; on `ack` mark confirmed; on `reject` roll back and refetch affected rows; on reconnect, re-send unconfirmed mutations (server dedupes) and pull from `lastSeq` (Replicache's rebase shape: [how it works](https://doc.replicache.dev/concepts/how-it-works)).

Reconnect:

- WS close → reconnect with exponential backoff + jitter (y-websocket caps at 2.5 s; use the 4400–4499 permanent / 45xx transient convention for auth failures and rate limits) ([y-websocket](https://github.com/yjs/y-websocket)). celld's 1012 on owner move, and Cloudflare's disconnect-on-deploy, are normal transients ([celld overview](https://celld.dev/docs), [hibernation docs](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).
- After `hello`, the server either streams missing ops or sends snapshot + tail. Chunk to ≤256 KiB frames; never exceed the ~1 MiB input budget in either direction ([celld compat](https://celld.dev/docs/cloudflare-compat)).

### 5.3 SSE fallback

- `GET /spaces/:id/events` returns `text/event-stream`; every event carries `id: <seq>`; heartbeat comment every 15–25 s (inside celld's 60 s window; also the HTML spec's ~15 s advice) ([celld compat](https://celld.dev/docs/cloudflare-compat), [HTML Standard](https://html.spec.whatwg.org/multipage/server-sent-events.html)).
- On reconnect, the browser sends `Last-Event-ID`; the server resumes after it exactly like `lastSeq`. Treat any stream error/close as "reconnect now" — celld reports expired streams as errors, not EOF.
- SSE is one-way: mutations go over HTTP `POST` with `Idempotency-Key: <clientId>:<mutationId>` using the same server apply path. This is also the natural fallback for proxies/old browsers and for read-only observers (low cost: no socket per watcher if using SSE fan-out).

### 5.4 Presence

- Ephemeral table/broadcast, TTL ~30 s (Yjs awareness precedent), removed on disconnect; re-announced on reconnect and every heartbeat ([y-protocols](https://github.com/yjs/y-protocols)).
- Store identity (`userId`, `sessionId`, space) in the socket attachment so it survives hibernation ([hibernation docs](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)); keep cursors out of SQLite.
- Throttle/batch cursor updates; this is the only traffic class that can plausibly hit the per-cell ceiling.

### 5.5 Rich text (escape hatch)

- If/when descriptions and comments need real co-editing: one Y.Doc per text field, updates appended to a `doc_updates` stream inside the space cell (or in the text field's own cell if it grows), with its own seq space. Send chunked binary frames; compact by loading and re-encoding periodically ([document updates](https://docs.yjs.dev/api/document-updates)).
- Do not let CRDT tombstones accumulate unbounded: Liveblocks markets "no tombstone growth" as a differentiator precisely because it is a common failure mode ([liveblocks.io/sync](https://liveblocks.io/sync)); Yjs GC only discards content, not structure ([INTERNALS](https://github.com/yjs/yjs/blob/main/INTERNALS.md)).

### 5.6 Operator defaults (celld)

- Prefer single-node + `CELLD_DURABILITY=bucket` given the open fleet-durability loss reports in the substrate findings, and back up bucket **and** node data; the substrate ticket already recommends this ([substrate findings](https://github.com/Siddhj2206/Vinnodrive/blob/research/celld-substrate/docs/research/celld-substrate.md), issues [#244](https://github.com/denoland/celld/issues/244), [#245](https://github.com/denoland/celld/issues/245), [#250](https://github.com/denoland/celld/issues/250)).
- Enable `CELLD_LTX_RETENTION_SECS` once the fleet is ready for epoch GC; it is what bounds bucket bytes ([celld overview](https://celld.dev/docs)).
- Keep an eye on the cell DB size against the 80/256 MiB cliffs; retain ops accordingly.

---

## 6. Risks and mitigations

| Risk | Why it matters | Mitigation |
|---|---|---|
| **celld is beta with open acknowledged-write-loss reports** ([#244](https://github.com/denoland/celld/issues/244), [#245](https://github.com/denoland/celld/issues/245), [#250](https://github.com/denoland/celld/issues/250), [#246](https://github.com/denoland/celld/issues/246), [#239](https://github.com/denoland/celld/issues/239); substrate summary) | Sync correctness assumes the server log survives | Single node + `bucket` durability; independent backups of bucket and node data; pin versions; rehearse restore; don't promise client "synced" beyond ack |
| **Forced reconnects** — 1012 on cell move/deploy/balancing, CF deploy closes all sockets | UX churn and duplicate work on reconnect | Resume-by-seq (`lastSeq`); idempotent mutations; backoff + jitter; show sync status |
| **1 MiB input budget** | A large catch-up or Yjs update kills the connection | Chunk catch-up ≤256 KiB; cap op payloads well below 1 MiB; never send snapshots as one frame |
| **60 s SSE stream expiry** | Silent-looking stale UI | Heartbeat comments every ≤30 s; treat any close/error as reconnect; `Last-Item-ID`/`lastSeq` resume |
| **In-memory interleaving / overlapping handlers** (celld does not wait for the previous handler; test alarms can overlap [#144](https://github.com/denoland/celld/issues/144)) | Race conditions if correctness lives across awaits | Mutation path is synchronous SQLite (or `transactionSync`); no in-memory sequencing; idempotent compaction |
| **Op log / DB growth** — no PITR, no purge, epoch GC off by default | Restores get slow; bucket grows | Materialized state + bounded op tail; daily idempotent alarm; verify free-page reclamation |
| **Single-writer ceiling** (~500–1,000 rps; 64 concurrent celld events) | Presence/cursor storms or automation can saturate a space | Batch/throttle presence; fan out reads via snapshots; keep global directory out of hot path |
| **Conflict semantics** — LWW silently drops overlapping edits | Lost work users won't notice | Per-field ops; append-only comments/history; explicit server-ordered positions for lists; conflict UX for status/assignee |
| **No BroadcastChannel in celld** | Multi-tab clients can't converge via the usual Yjs cross-tab channel | One WS per tab (server fans out) or SharedWorker/localStorage leader election inside the app |
| **No platform auth** | Data exposure | Auth at Worker/proxy; per-space ACL checks inside the DO; never expose the celld internal listener |

---

## 7. Open questions

1. **celld outbound frame behavior.** No documented budget for outbound frames; verify large (2–5 MiB) sends, chunk boundaries, and how the output gate interacts with streaming many small frames.
2. **`serializeAttachment` fidelity on celld.** The compat page lists no exception for the hibernation API, but attachments are not documented explicitly. Prototype before storing session state there.
3. **Does a heartbeat write reset the 60 s stream window?** The docs say "a successful stream operation starts a new 60-second period"; confirm that a comment-only SSE write counts.
4. **SQLite space reclamation.** Does celld's DO SQLite support `VACUUM`/`auto_vacuum`, or does deleting 100 MB of ops leave the file bloated? Test.
5. **Practical max cell DB on homelab MinIO.** celld documents no per-cell cap; the substrate findings flag MinIO as unqualified and page-fault behavior as blocking (substrate open question #1).
6. **Offline retention contract.** How long can a client be offline before a full snapshot resync? This is a product decision encoded in the op-retention alarm.
7. **List/board ordering under concurrent inserts.** Choose an ordering scheme now (fractional indexing with server tie-break, or an append-only ordered-items table) so the op model doesn't need to change later. Liveblocks keeps both inserts and lets the server order them ([conflict resolution](https://liveblocks.io/docs/guides/how-conflict-resolution-works-in-liveblocks-sync)).
8. **Text: Yjs now or later?** Only worth it if descriptions/comments become true co-editing. The escape hatch above keeps the door open.
9. **Multi-tab coordination without BroadcastChannel.** SharedWorker, localStorage leader election, or accept one socket per tab.
10. **Presence under hibernation.** Attachments survive, in-memory maps don't; decide whether to persist presence rows with TTLs or rely on re-announcement.
11. **Directory cell design.** How cross-space views (my tasks, recent files) stay fresh without making the directory a hot single writer.
12. **Fleet later.** Cells move and close sockets; the name-based reconnect protocol above should survive it, but test a node drain with live clients.

---

## Primary sources

**celld:** [overview / cell lifecycle / storage cliffs](https://celld.dev/docs) · [Cloudflare compatibility (WS frames, streams, EventSource)](https://celld.dev/docs/cloudflare-compat) · [Durable Objects / Cells](https://celld.dev/docs/services/durable-objects) · [security](https://celld.dev/docs/security) · [README (heap, ~50k sockets)](https://github.com/denoland/celld/blob/main/README.md) · [docs source](https://github.com/denoland/celld/blob/main/docs/README.md) · issues [#125 PITR](https://github.com/denoland/celld/issues/125), [#144 overlapping alarms](https://github.com/denoland/celld/issues/144), [#244](https://github.com/denoland/celld/issues/244), [#245](https://github.com/denoland/celld/issues/245), [#250](https://github.com/denoland/celld/issues/250).

**Cloudflare:** [hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) · [DurableObjectState (32,768 sockets, tags, attachments)](https://developers.cloudflare.com/durable-objects/api/state/) · [Workers WebSockets (32 MiB, 1009)](https://developers.cloudflare.com/workers/runtime-apis/websockets/) · [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) · [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [SQLite storage API (PITR 30 days)](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) · [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) · [Rules of DOs](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) · [input/output gates](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/) · [workers-chat-demo](https://github.com/cloudflare/workers-chat-demo).

**Protocols & prior art:** [Yjs INTERNALS](https://github.com/yjs/yjs/blob/main/INTERNALS.md) · [Yjs document updates](https://docs.yjs.dev/api/document-updates) · [Y.Doc](https://docs.yjs.dev/api/y.doc) · [y-protocols](https://github.com/yjs/y-protocols) · [y-websocket (reconnect/close codes)](https://github.com/yjs/y-websocket) · [Automerge sync](https://automerge.org/automerge/automerge/sync/index.html) · [Automerge sync paper](https://arxiv.org/abs/2012.00472) · [automerge-repo](https://automerge.org/docs/reference/repositories) · [Linear delta sync](https://linear.app/now/rebuilding-delta-sync-read-path) · [Linear scaling talk](https://linear.app/blog/scaling-the-linear-sync-engine) · [Actual proto](https://github.com/actualbudget/actual/blob/master/packages/crdt/src/proto/sync.proto), [HLC](https://github.com/actualbudget/actual/blob/master/packages/crdt/src/crdt/timestamp.ts), [merkle](https://github.com/actualbudget/actual/blob/master/packages/crdt/src/crdt/merkle.ts) · [Liveblocks conflict resolution](https://liveblocks.io/docs/guides/how-conflict-resolution-works-in-liveblocks-sync) · [Liveblocks Sync](https://liveblocks.io/docs/products/sync) · [PartyKit](https://docs.partykit.io/how-partykit-works/) · [Jazz sync](https://jazz.tools/docs/concepts/how-sync-works) · [Jazz self-host](https://classic.jazz.tools/docs/vanilla/core-concepts/sync-and-storage) · [Replicache](https://doc.replicache.dev/concepts/how-it-works) · [HTML SSE spec](https://html.spec.whatwg.org/multipage/server-sent-events.html).

**Project context:** [celld substrate findings (branch)](https://github.com/Siddhj2206/Vinnodrive/blob/research/celld-substrate/docs/research/celld-substrate.md) · [map issue #1](https://github.com/Siddhj2206/Vinnodrive/issues/1) · [ticket #4](https://github.com/Siddhj2206/Vinnodrive/issues/4).
