# celld as substrate for a self-hosted drive — research findings

**Subject:** [celld](https://celld.dev) / [denoland/celld](https://github.com/denoland/celld) — "self-hosted, distributed Durable Objects".
**Version examined:** v0.6.1 (released 2026-10-01), Apache-2.0, by Deno Land. All sources accessed **2026-10-04**.
**Question:** can a self-hosted, multi-user file drive (Nextcloud-like) be built on celld today, for homelab/NAS/single-server deployment?

Sources are primary: celld.dev docs, the GitHub repo (docs/, examples/, crates/, releases, issues), `install.sh`, the Dockerfile, and Cloudflare docs where celld claims API compatibility. Quotes are verbatim. Uncertainty is labelled explicitly. Docs on celld.dev are generated from `celld/docs/` in the repo, so both URLs name the same text.

---

## 1. What celld is

**Architecture.** celld is an open-source daemon that runs the Cloudflare Workers programming model on your own machines, storing durable state in a bucket you own:

> "celld is an open-source daemon that runs a Cloudflare Workers application on your own machines: Workers, Durable Objects, KV, Queues, D1, R2, Workflows, Cron Triggers, and static assets, deployed from the `wrangler.json` that you already have. Each object is a cell: a named server with its own SQLite database."
> — [README](https://github.com/denoland/celld/blob/main/README.md)

The unit model:

- A **node** is one `celld` process on one machine. A **fleet** is the set of nodes sharing one bucket.
- A **cell** is a Durable Object: "a small server with a name and a private SQLite database. You make one cell for each user, document, chat room, or AI agent." Each cell runs on one thread; "storage operations are synchronous and never interleave". ([docs overview](https://celld.dev/docs))
- **Ownership** is decided by the bucket, not by consensus: "a node claims a cell by writing a small record to the bucket. The store accepts the write only if no other node changed the record first… The claim expires unless the node renews it." The fleet "needs no membership protocol, failure detector, or consensus service"; peers find each other via node leases. ([docs overview](https://celld.dev/docs), [README](https://github.com/denoland/celld/blob/main/README.md))
- State is replicated as SQLite-to-LTX streams under `cells/<cell>/ltx/e<epoch>/`, plus ownership records, node leases, deployments, and `fleet/peer-auth.json`, all in the same bucket. Reserved prefixes: `probe/`, `cells/`, `nodes/`, `node-cells/`, `fleet/`, `deploy/`, `deploy-blobs/`, `log/`, `wake/`, `telemetry/` ([guarantees](https://celld.dev/docs/guarantees)).

**Services implemented** (all "Supported" unless noted; from [cloudflare-compat](https://celld.dev/docs/cloudflare-compat) and [landing page](https://celld.dev)):

| Service | Status | Note |
|---|---|---|
| Workers | Supported | stateless `fetch` handlers, service bindings, JS RPC, partial Node compat |
| Durable Objects / Cells | Supported | SQLite storage, alarms, hibernating WebSockets |
| Durable Object Facets | Supported | child objects, separate SQLite each |
| KV | Supported | namespace = one cell; value >1 MiB requires fleet bucket |
| Queues | Supported | producer/consumer, batching, retries, DLQ; 4-day retention |
| D1 | Supported | database = one cell |
| R2 | Supported | binding writes to the *fleet bucket* directly |
| Workflows | Supported | durable steps; 1 MiB payloads; 30-day instance retention |
| Cron Triggers | Supported | one run per occurrence across the fleet |
| Static assets | Supported | asset or asset+Worker; 20k assets / 1 GiB per deployment |
| Dynamic Workers | Supported | runtime-loaded code; 256 live limit |
| Containers | **Experimental** | DO-supervised container, `@cloudflare/containers` |
| Sandboxes | Supported | Cloudflare Sandbox SDK example |
| Workers AI, Vectorize, Hyperdrive, Browser Rendering, Email | **No** | out of scope |
| Python Workers | **Partial** | `fetch` handlers only, Pyodide 0.28.3 / CPython 3.13.2 |

**Maturity.** v0.6.1 is a **beta**; the project launched publicly around 2026-08-02 (first release v0.0.1) and has shipped 12 releases in two months: v0.0.1 (Aug 2) → v0.6.1 (Oct 1, 2026) ([releases](https://github.com/denoland/celld/releases)). The `main` branch shows only 12 commits and **pull requests are disabled**; contributions go by emailed `git format-patch` with a CLA ([README](https://github.com/denoland/celld/blob/main/README.md)). Repo stats at time of writing: ~5.0k stars, 207 forks, 35 open issues. The security page is blunt:

> "celld v0.6.1 is a beta release. It is not safe for hostile multi-tenant use. Security fixes apply to the latest release only, so older beta releases do not receive fixes."
> — [docs/security](https://celld.dev/docs/security)

---

## 2. Deployment & ops

### Install

- **Binary:** `curl -fsSL https://celld.dev/install.sh | sh`. The installer downloads a static executable (~58 MB per the landing page) for **Linux x86-64, Linux ARM64, or Apple Silicon**; **Windows is not supported** ([limitations](https://celld.dev/docs/limitations)). Releases carry GitHub Actions build attestations (`gh attestation verify <asset> --repo denoland/celld`). The installer keeps releases under `~/.local/lib/celld/releases` and swaps a symlink; re-running with `CELLD_VERSION=vX.Y.Z` is a rollback ([install.sh](https://celld.dev/install.sh), [docs overview](https://celld.dev/docs)).
- **Docker:** `ghcr.io/denoland/celld`, published for Linux x86-64 and ARM64; persist `/var/lib/celld` via `CELLD_WATCH` and pass AWS credentials ([README](https://github.com/denoland/celld/blob/main/README.md)). The image is Debian bookworm-slim with `ca-certificates` and the binary ([Dockerfile](https://github.com/denoland/celld/blob/main/Dockerfile)).
- **esbuild** must be on `PATH` for `celld deploy` of Worker code (asset-only projects don't need it) ([README](https://github.com/denoland/celld/blob/main/README.md)).
- **Local dev:** `celld dev` runs one node with a **local SQLite object store** in `.celld/dev`, no bucket required. Crucially: "The command does not expose the local object store through a fleet flag. A regular node or an operator subcommand must use a supported cloud bucket." ([docs overview](https://celld.dev/docs))

### Bucket requirements (the hard part for homelab)

celld needs four storage properties: conditional create, conditional overwrite, read-after-write consistency, and ranged reads (plus list-after-write consistency if epoch GC is enabled) ([guarantees](https://celld.dev/docs/guarantees)). Qualified stores:

> "Amazon S3, Cloudflare R2, Google Cloud Storage, Tigris, and Azure Blob Storage qualify; Backblaze B2, Hetzner, and DigitalOcean Spaces do not. MinIO (the community edition) passes the storage test, but celld has not qualified it for production; do not use RELEASE.2025-09-06T17-38-46Z, which rejects the conditional create that the first deploy sends (denoland/celld#162)."
> — [docs overview](https://celld.dev/docs)

Every node also runs the storage test at startup and "stops immediately when a required conditional write or ranged read is unsupported"; `celld diagnose` runs the test manually ([guarantees](https://celld.dev/docs/guarantees)). **So: a local MinIO works in practice (passes the test, and MinIO is used in celld's own recent bug reproductions), but is explicitly not qualified for production.** Garage, Ceph/RGW, rsync.net: **not mentioned in primary sources** — treat as unknown; test with `celld diagnose`.

### TLS, domains, auth

- **No TLS and no ACME:** "celld does not terminate TLS. Terminate public TLS at an ingress proxy" ([limitations](https://celld.dev/docs/limitations)). It does not manage custom domains either ([workers docs](https://celld.dev/docs/services/workers)). A reverse proxy/load balancer (Caddy/nginx/Traefik + Let's Encrypt) is required for a self-hosted drive.
- **Two listeners:** public (`--listen`) and internal (`--internal-listen`, peer protocol + operator API). Internal traffic is plaintext HTTP, authenticated for tunnels/control by a fleet HMAC established via `fleet/peer-auth.json`; "the operator API … does not authenticate the caller" and **must not reach the internet** ([security](https://celld.dev/docs/security)). An open issue reports Workers can reach the unauthenticated operator routes on a shared host/network ([#220](https://github.com/denoland/celld/issues/220)).
- **End-user auth is entirely app-level:** "The public listener | Terminate TLS and authenticate users in a proxy or the application." ([security](https://celld.dev/docs/security)). There is no built-in accounts, sessions, JWT, or Cloudflare Access equivalent (see §5).
- **Bucket credentials are fleet root:** "A person who holds the bucket credentials controls the fleet." Keep one credential to one bucket ([security](https://celld.dev/docs/security)).

### Backups, restore, upgrades

- There is **no backup feature or backup doc**; the only restore guidance is the fleet-format upgrade procedure: "Back up the stopped fleet's bucket and node data… A follower disk can contain acknowledged writes that the bucket does not yet contain." ([guarantees](https://celld.dev/docs/guarantees)). In `fleet` durability mode the bucket is *not* always a complete backup of acknowledged writes — follower disks can hold acked writes not yet uploaded.
- **No point-in-time restore:** "Point-in-time restore is unsupported… Although LTX supports PITR internally, it's not exposed to JS" ([#125](https://github.com/denoland/celld/issues/125)). Bucket-level versioning/lifecycle is the operator's tool.
- **No permanent cell deletion:** `storage.deleteAll()` empties the current DB but retains replicated history in the bucket; there is no purge API ([#175](https://github.com/denoland/celld/issues/175)).
- **Upgrades are version-sensitive.** Generally: "Stop all old nodes, then start the new binaries" and note which steps may *not* be rolling — v0.1→0.2 no, v0.3→0.4 no, **v0.5.1→v0.6.0 no when using the default `fleet` durability**, v0.6.0→v0.6.1 yes ([docs overview](https://celld.dev/docs)). A supervisor must restart the process on failure, without an attempt limit, waiting at least one lease lifetime between attempts ([guarantees](https://celld.dev/docs/guarantees)). You must also set an orchestrator stop grace exceeding `CELLD_SHUTDOWN_TOTAL_MS` (default 40 s) ([docs overview](https://celld.dev/docs)).

### Observability

- OpenTelemetry is opt-in: `CELLD_OTEL=1` writes Parquet under `telemetry/` in the fleet bucket (queryable with DuckDB), or `CELLD_OTEL=http://collector:4318` for OTLP/HTTP. "celld records no metrics yet" — spans carry durations ([telemetry](https://celld.dev/docs/telemetry)).
- `celld diagnose` probes nodes; `/state` on the internal listener reports live counters; the public health path is `/.well-known/celld/health` (boolean, 503 while draining) ([docs overview](https://celld.dev/docs), [security](https://celld.dev/docs/security)).
- `celld cell list`, `celld cell gc --dry-run`, `celld d1`, `celld kv`, `celld r2`, `celld queue` are operator CLIs that talk to the bucket ([docs overview](https://celld.dev/docs)).

### Minimum viable single-node self-host

1. One supported machine (Linux x86-64/ARM64) with the celld binary (or Docker).
2. One **qualified** bucket, or a homelab MinIO with the caveat that it is unqualified (test with `celld diagnose`; avoid the broken MinIO release; note MinIO is also what the recent data-loss repros used, [#244](https://github.com/denoland/celld/issues/244)).
3. A TLS-terminating reverse proxy in front of `--listen`; the internal listener on loopback/private network only.
4. A supervisor (systemd/docker restart policy) with a stop grace > 40 s.
5. `celld deploy . --bucket ...` from a machine with esbuild.

A single node is *correct* but every acknowledged write waits for the bucket: "a single node has nobody to send to, so every write waits for the bucket" ([docs overview](https://celld.dev/docs)). The landing page advertises ~90 ms durable write latency for one node against a region-local store; a second node drops that to ~25 ms in their lab ([landing](https://celld.dev), [testing](https://celld.dev/docs/testing)). No published numbers exist for a local MinIO on the same box (**unknown**).

---

## 3. App programming model

### Write & deploy

- You keep a Wrangler project. `celld deploy` accepts `wrangler.jsonc`/`wrangler.json` (**not `wrangler.toml`**), bundles with esbuild, and **stops on any unknown top-level key**, including `routes` ([cloudflare-compat](https://celld.dev/docs/cloudflare-compat)).
- Accepted top-level keys: `$schema`, `name`, `main`, `no_bundle`, `compatibility_date`, `compatibility_flags`, `durable_objects`, `migrations`, `assets`, `services`, `triggers`, `vars`, `d1_databases`, `kv_namespaces`, `queues`, `workflows`, `r2_buckets`, `worker_loaders`, `containers`, `define`, `rules` ([cloudflare-compat](https://celld.dev/docs/cloudflare-compat)).
- `name` must be 1–63 lowercase ASCII letters/digits/internal hyphens. A `migrations` entry accepts only `tag` and `new_sqlite_classes`; class rename/delete/transfer stop the deployment ([cloudflare-compat](https://celld.dev/docs/cloudflare-compat), [durable-objects](https://celld.dev/docs/services/durable-objects)).
- Deployments are immutable objects under `deploy/`; a pointer (`deploy/current.json`) is polled every 30 s (`CELLD_DEPLOY_POLL_S`) and adopted **in place without restart**. "A `celld` node verifies each module [SHA-256] before it builds the deployment." ([docs overview](https://celld.dev/docs)). There is no rollback/preview/list command — open request [#181](https://github.com/denoland/celld/issues/181); and deploys can silently fail to be adopted fleet-wide (open [#218](https://github.com/denoland/celld/issues/218)).
- **No secret store:** there is no `celld secret put` equivalent (open [#190](https://github.com/denoland/celld/issues/190)); `.dev.vars` is local-only and "Only `celld dev` reads the file, so a local credential does not reach a fleet through `celld deploy`" ([docs overview](https://celld.dev/docs)). Secrets must live in `vars` (deployment data in the bucket) or come from outside (**unknown how the app would read operator env vars**).

### How bindings resolve

- **Durable Objects, KV, Queues, D1, Workflows:** each is a **cell** with a lease, SQLite, LTX replication, and failover; calls are routed to the owning node ([landing](https://celld.dev), [workers](https://celld.dev/docs/services/workers)).
- **R2:** no cell — "An R2 binding has no cell, and it reads and writes the fleet bucket directly." Each binding is a logical bucket mapped to `r2/<bucket_name>/<key>` in the same fleet bucket. "There is no public bucket URL, no presigned URL, and no S3 endpoint into an R2 binding, so an application must put a Worker in front of the bytes it wants to publish." ([workers](https://celld.dev/docs/services/workers), [r2](https://celld.dev/docs/services/r2))
- Service bindings and JS RPC work; RPC stubs cannot cross isolate boundaries and a remote RPC retries only when the failed attempt provably did not start ([cloudflare-compat](https://celld.dev/docs/cloudflare-compat)).

### Runtime constraints relevant to an app

- **Node.js compat is partial:** implements `node:assert`, `async_hooks`, `buffer`, `diagnostics_channel`, `events`, `fs`, `os`, `path`, `stream`, `timers/promises`, `util`. `node:crypto` lacks Diffie-Hellman, streaming signatures, ciphers, RSA-PSS/DSA; `node:zlib` is sync gzip/deflate only; `node:fs` provides only access/mkdir/realpath/stat/lstat/readFile with an empty request-local `/tmp` and read-only `/bundle`. Anything else must be bundled for the browser/worker environment with esbuild ([cloudflare-compat](https://celld.dev/docs/cloudflare-compat)).
- **No Cache API:** always-miss cache; static assets use a per-node 512 MiB disk cache ([cloudflare-compat](https://celld.dev/docs/cloudflare-compat), [static-assets](https://celld.dev/docs/services/static-assets)).
- **Heap:** each isolate has a V8 heap limit, default **128 MB** (`CELLD_V8_HEAP_LIMIT_MB`). An isolate above 90% refuses new hibernatable WebSockets; at the limit, SQL result materialization stops ([README](https://github.com/denoland/celld/blob/main/README.md)). **Per-request CPU limits are not documented** for celld Workers (Cloudflare's is 30 s; celld documents 30 s only for transactions/`blockConcurrencyWhile`) — **unknown**.
- **Concurrency per cell:** `CELLD_MAX_CELL_REQUESTS` default **64** concurrent fetch events; excess gets HTTP 503 `Retry-After: 1` / `X-Celld-Overload: cell` ([docs overview](https://celld.dev/docs)).
- **Memory pressure:** pressure shedding at 80% of available memory by default; absolute cgroup cap at 95%; idle eviction via `CELLD_IDLE_EVICT_S` (unset by default); `CELLD_MAX_RESIDENT_CELLS` caps residency ([README](https://github.com/denoland/celld/blob/main/README.md)).
- **Request/response limits:**
  - Body: **1 GiB hard cap** per public Worker request or `/do/<ID>` — `CELLD_MAX_REQUEST_BODY_BYTES` can only be *reduced* (source asserts `cannot exceed` the 1 GiB default; `DEFAULT_MAX_REQUEST_BODY_BYTES = 1 << 30`) ([security](https://celld.dev/docs/security), [crates/celld/main.rs](https://github.com/denoland/celld/blob/main/crates/celld/main.rs), [crates/celld/actor.rs](https://github.com/denoland/celld/blob/main/crates/celld/actor.rs)).
  - Streams: an unclaimed/inactive HTTP stream expires after **60 s**; each successful stream operation starts a new 60-s window ([cloudflare-compat](https://celld.dev/docs/cloudflare-compat)).
  - Responses: "celld removes `Content-Length` from a Worker response, except for a `HEAD` response" ([cloudflare-compat](https://celld.dev/docs/cloudflare-compat)).
  - WebSockets: hibernatable sockets supported, but input queues have a 1 MiB budget for non-terminal frames; a message larger than 1 MiB uses the complete budget; an outbound DO socket closes when its event/`waitUntil` work ends ([cloudflare-compat](https://celld.dev/docs/cloudflare-compat)). Hibernatable sockets survive hibernation on the same node and close (code 1012) when the cell moves; clients must reconnect ([durable-objects](https://celld.dev/docs/services/durable-objects), [limitations](https://celld.dev/docs/limitations)).
  - SSE works (EventSource/streaming responses) subject to the 60-s stream rule and the output gate; no celld-specific SSE doc was found.

---

## 4. Fit for a drive specifically

### Multi-GB uploads

- **Per-request 1 GiB cap** forces client-side chunking for anything bigger (§3).
- R2 `put(key, stream)` writes small bodies in one request; "a streamed body that grows past 8 MiB becomes a multipart upload to the object store" ([r2](https://celld.dev/docs/services/r2)).
- Explicit multipart API exists: `createMultipartUpload(key)` → `uploadPart(number, value)` → `complete(parts)`. Limits come from Cloudflare R2: **max object 5 TiB, 5 MiB–5 GiB per part, 10,000 parts, all parts except the last the same size** ([r2](https://celld.dev/docs/services/r2), [Cloudflare R2 uploads](https://developers.cloudflare.com/r2/objects/upload-objects/)).
- celld's multipart caveats are the big ones:
  - "celld holds the upload in the node that opened it… An upload therefore **cannot resume on another node or after a restart**." ([r2](https://celld.dev/docs/services/r2))
  - "celld hands the parts to the object store in ascending order… A part that arrives before its predecessor waits in memory, and that backlog can reach **256 MiB** before celld refuses a further part." ([r2](https://celld.dev/docs/services/r2))
  - "A conditional write cannot use a streamed body larger than 8 MiB." ([r2](https://celld.dev/docs/services/r2))
  - "`createMultipartUpload()` does not accept a checksum." ([r2](https://celld.dev/docs/services/r2))
- **No presigned URLs and no public bucket endpoint** mean all upload bytes traverse a Worker on a celld node; there is no browser→S3 direct path. Practical consequence for a drive: the node is in the data path for every byte, and a retry after a node restart must restart the multipart upload.

### Downloads / range requests

- `get()` supports ranges in every R2 spelling (`offset`, `length`, `suffix`, `Range` header), and the body "arrives as a `ReadableStream` from the host, so a large object never has to fit in the isolate heap" ([r2](https://celld.dev/docs/services/r2)). Video seeking via `Range` is feasible.
- Because there are no presigned URLs, share-link downloads and video streaming also flow through a Worker; the 60-s stream-expiry rule and missing `Content-Length` are the operational quirks to test with real clients.
- `celld r2 get` streams an object to stdout without loading it into memory, useful for backup/export tooling ([docs overview](https://celld.dev/docs)).

### Many files per user; cells and SQLite

- The intended shape is one cell per user/tenant: "Sharded web applications. One cell for each user, each tenant… the contention of one shared database does not appear, because no shared database exists." ([docs overview](https://celld.dev/docs)).
- D1 constraints that carry over: statement ≤100 KB, ≤100 bound parameters, ≤100 columns, string/BLOB/row ≤2.2 MB, result ≤100,000 rows or 32 MiB; one writer per database; no `BEGIN`/`VACUUM`/`ATTACH`; no read replicas, no Time Travel ([d1](https://celld.dev/docs/services/d1)).
- **celld does not document a maximum size for a cell's SQLite database.** Cloudflare's reference points are 10 GB per SQLite-backed DO and 10 GB per D1 database ([DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). What celld *does* document are practical costs that bite as a DB grows:
  - Handoff snapshots: "A database larger than the deadline can upload, **80 MiB at the default deadline of 10 seconds**, skips the snapshot and hands off through its L0 chain at once" ([docs overview](https://celld.dev/docs)).
  - Restore paging starts at 256 MiB (`CELLD_LTX_PAGED_MIN_MB`); a page fault "reads the bucket synchronously inside the JavaScript turn, so it blocks the cell… A query that reads many such pages can therefore take minutes." Hydration runs at 16 MiB/s per node by default ([docs overview](https://celld.dev/docs)).
  - Without epoch GC (`CELLD_LTX_RETENTION_SECS`, **off by default**), "the bytes of a cell increase with each activation that adds a prefix" ([docs overview](https://celld.dev/docs)). Epoch GC requires list-after-write consistency.
- Listing is paginated at 1000 keys in the binding/CLI APIs; `delete()` removes up to 1000 keys per call ([r2](https://celld.dev/docs/services/r2), [docs overview](https://celld.dev/docs)). A per-user file table in that user's cell is the natural metadata model, with R2 keys under a per-user prefix.
- **Single writer per cell** means a user's metadata writes serialize; per-file upload cells or direct R2 writes avoid funneling blobs through one cell. "Two statements against one database therefore run one after the other, even when they touch different tables. More nodes do not divide that work" ([d1](https://celld.dev/docs/services/d1)).

### Consistency & durability (RPO/RTO)

The design intent ([landing](https://celld.dev), [guarantees](https://celld.dev/docs/guarantees), [testing](https://celld.dev/docs/testing)):

- Exactly one node owns a cell at a time; epochs fence stale writers: "Exactly one node serves a cell at a time, so two machines never write the same database."
- "celld does not answer a write until that write survives a failure" — RPO=0.
- Single node: every ack waits for a bucket round trip (~90 ms region-local). Two or more nodes: "the node serving the cell sends each write to another node as well, and answers as soon as that node has the data on its own disk"; ack stands if *either* follower fsync or bucket upload completes. `CELLD_DURABILITY=fleet` is the default.
- Failover (landing page): ~20 s after node loss with zero lost writes. The 10-node lab test reports "data of every cell was available again on another node in ~11 s at the tail" ([testing](https://celld.dev/docs/testing)).
- Testing is unusually serious: TLA+ model checking ("found four bugs and a split-brain that lost an acknowledged write. All are fixed"), deterministic simulation, and live kill tests ("Stop a node with `SIGKILL` in the middle of a write stream and delete its local database… Every acknowledged write comes back"). But: "The measured restore times come from the retired external replicator, so this page gives no number until a fleet run measures `celld-ltx`." ([testing](https://celld.dev/docs/testing))

**Counter-evidence from open issues (all filed 2026-09-29 to 2026-10-02, none with a maintainer reply at time of writing):**

- [#244](https://github.com/denoland/celld/issues/244): on v0.6.0, "a restart after a fleet-wide fence either declares a loss of acknowledged writes or wedges recovery indefinitely, depending on which node comes back first, unless every node keeps its `CELLD_NODE` id **and** the whole fleet restarts together within the witness grace. The docs do not say this." Reported losses of 1,291–1,400 of ~6,100 committed writes in a 2-node + MinIO setup. **If true, the RPO=0 claim does not hold for this operational sequence in the current beta.**
- [#245](https://github.com/denoland/celld/issues/245): after a declared loss, new writes reuse sequence numbers of written-off acknowledged writes; a 3-node fleet was observed keeping only a one-follower ensemble, so the third node did not protect the acknowledged tail.
- [#250](https://github.com/denoland/celld/issues/250): recovery cannot read a follower tail larger than 10 s of transfer (607 MB fragment) and recovery wedges ("refusing to seal"); a second user confirmed similar behaviour.
- [#246](https://github.com/denoland/celld/issues/246): peerlog disk use "grows out of control until Kubelet evicts the pod" after snapshot evictions.
- [#239](https://github.com/denoland/celld/issues/239): on AWS S3, `ConditionalRequestConflict` (409) on lease renewal causes self-fencing about 10×/day on their 3-node fleet; 0 × 412 in 21,062 lease writes.

These issues are about the **default `fleet` durability** path and node-failure recovery — exactly the failure modes a family drive would eventually hit (power loss, NAS reboot, bucket outage). `CELLD_DURABILITY=bucket` is more conservative but slower and still subject to the same ownership/lease machinery.

---

## 5. Identity / multi-tenancy

**Entirely app-level.** celld provides no accounts, users, sessions, JWT, or Access-compatible layer. Primary evidence:

- "A fleet runs one application. celld has no account service, multi-tenant scheduler, or managed ingress." ([limitations](https://celld.dev/docs/limitations))
- "The public listener | Terminate TLS and authenticate users in a proxy or the application." ([security](https://celld.dev/docs/security))
- "It is not safe for hostile multi-tenant use… Application code can use its configured bindings and can consume shared node resources. Do not run code from mutually distrusting tenants in one fleet." ([security](https://celld.dev/docs/security))

For a drive this means: multi-user support is a feature you build (users, sessions, ACLs, share tokens) inside one trusted application; that is normal for a Nextcloud-like app, where users are data tenants, not code tenants. But your app must treat uploaded content as untrusted data, and there is no platform identity to delegate to.

---

## 6. Maturity / risk

**Signals for:**

- 5.0k stars / 207 forks; 12 releases in 8 weeks; very thorough engineering docs (guarantees, testing with TLA+/simulation/kill tests); stable on-disk formats guarded by explicit upgrade notes; Apache-2.0; build attestations; a public "limitations" page and a "not safe for hostile multi-tenant" warning.
- Kill test: SIGKILL mid-write + delete local DB → all acknowledged writes recovered ([testing](https://celld.dev/docs/testing)).

**Signals against (for a drive that holds the family photos):**

- **Beta with a 2-month history**; "Security fixes apply to the latest release only" ([security](https://celld.dev/docs/security)).
- Open, unanswered data-integrity reports in the default fleet mode: [#244](https://github.com/denoland/celld/issues/244), [#245](https://github.com/denoland/celld/issues/245), [#250](https://github.com/denoland/celld/issues/250), [#246](https://github.com/denoland/celld/issues/246), [#239](https://github.com/denoland/celld/issues/239). This is the single biggest risk.
- Upgrade path contains mandatory full-fleet stops (v0.5.1→v0.6.0 with fleet durability; earlier v0.3→v0.4 etc.), and some paths can lose acknowledged writes if downgraded ([docs overview](https://celld.dev/docs)).
- No PITR ([#125](https://github.com/denoland/celld/issues/125)); no permanent cell purge ([#175](https://github.com/denoland/celld/issues/175)); no built-in backup. Restore is operator work.
- MinIO — the obvious homelab store — "passes the storage test, but celld has not qualified it for production", and one release is known-broken (issue [#162](https://github.com/denoland/celld/issues/162)).
- No metrics yet in telemetry ([telemetry](https://celld.dev/docs/telemetry)); operator API unauthenticated ([security](https://celld.dev/docs/security), [#220](https://github.com/denoland/celld/issues/220)); deploy adoption can silently fail ([#218](https://github.com/denoland/celld/issues/218)).

**Verdict on data-loss risk:** the architecture targets RPO=0 and the test programme is serious, but on v0.6.x the default `fleet` durability has open, reproducible acknowledged-write-loss and recovery-wedge reports. Running a personal/family drive on celld today means accepting beta-level data-loss risk unless you (a) stay on a single node with `CELLD_DURABILITY=bucket`, (b) keep independent backups of the bucket *and* node data, and (c) pin versions and rehearse restores. Even then, bucket-level or lease-level faults affect all data at once.

---

## 7. Prior art

**On celld (community), found via GitHub search and issue references:**

- [kentcdodds/kody-celld](https://github.com/kentcdodds/kody-celld) — "Self-hostable kody.codes" (an application runtime, not a drive).
- [ewhauser/celld-operator](https://github.com/ewhauser/celld-operator) — a Kubernetes operator for celld (mentioned in [#223](https://github.com/denoland/celld/issues/223)).
- [taeold/celld-cloud-run-demo](https://github.com/taeold/celld-cloud-run-demo), [ewhauser/world-celld](https://github.com/ewhauser/world-celld), [academind/celld-vs-cloudflare-demo](https://github.com/academind/celld-vs-cloudflare-demo) — demos/experiments.
- **No file-drive/WebDAV/sync app built on celld was found in primary sources.**

**File/drive-like apps on Cloudflare Workers + Durable Objects/R2 (adaptable ideas; not celld-tested and they rely on Cloudflare-only features such as presigned URLs):**

- [abersheeran/r2-webdav](https://github.com/abersheeran/r2-webdav) (419★), [aigem/CFr2-webdav](https://github.com/aigem/CFr2-webdav) (225★) — WebDAV over R2 through Workers.
- [fanchenggang/Davflare](https://github.com/fanchenggang/Davflare) (73★) — "Self-hosted cloud drive on Cloudflare R2 — web file manager + WebDAV, with chunked uploads, expiring share links, trash, thumbnails".
- [sagan/FlareDrive](https://github.com/sagan/FlareDrive) — file service with Web UI & WebDAV using Workers, R2, KV and D1.
- [janwilmake/do-ingest-api-aggregate-r2](https://github.com/janwilmake/do-ingest-api-aggregate-r2) — aggregating many file writes in a DO and streaming to R2 "circumventing limitations"; [janwilmake/cloudflare-fs](https://github.com/janwilmake/cloudflare-fs) and [corca-ai/cf-vfs](https://github.com/corca-ai/cf-vfs) — filesystem abstractions over DO/R2.
- [Paul-Gy/SessionShare](https://github.com/Paul-Gy/SessionShare) (52★) — expiring share links on Workers + DO.

**Sync/WebDAV primitives in celld:** none built in. You'd implement WebDAV as app routes over the R2 binding, or provide a proprietary sync API. Node compat is too partial to reuse an existing Node WebDAV server (no `fs` write APIs, no `child_process`, no native modules), and there are no presigned URLs to delegate byte transfer.

---

## 8. What building a drive on celld concretely implies

### Suggested high-level shape (all documented capabilities)

- **One fleet, one app, one bucket.** Every user's metadata and every file byte live in the same fleet bucket: cell state under `cells/`, files under `r2/<bucket_name>/<key>`.
- **Users/sessions/ACLs:** app-level Worker code; cookie/JWT issuing and verification with Web Crypto (HMAC/Ed25519/RSA-OAEP are supported, with caveats), or an external IdP. Secrets are a known gap ([#190](https://github.com/denoland/celld/issues/190)).
- **Metadata:** shard per user. Either one Durable Object per user (SQLite + KV API) or one D1 database per user (same cell machinery, SQL + migrations). Keep a small global directory (users, quotas, share tokens) in one D1 or KV namespace, accepting its single-writer ceiling; for a family-scale drive that is fine.
- **Blobs:** one R2 binding (`r2_buckets`) storing keys like `files/<user>/<file-id>/<version>`; folders as metadata rows, not objects; a zero-byte marker only if you want CLI/tooling visibility.
- **Upload:** browser chunking (e.g. 8–64 MiB chunks) → Worker → `createMultipartUpload/uploadPart/complete`; the chunk session state in the user's cell; track `uploadId` and parts there. Expect: parts in ascending order (or ≤256 MiB out-of-order buffer in node RAM), no cross-node/cross-restart resume, 1 GiB per HTTP request cap, no conditional writes for >8 MiB streams.
- **Download/preview:** Worker `get(key, {range})` streaming; video seeking via `Range`; thumbnails generated in-app (WASM image codec, or an external service; Workers AI is out of scope) with a Workflow/Queue for async processing.
- **Share links:** token rows in the owner's cell; a public Worker route validates and streams from R2. No presigned URLs, so all traffic is proxied.
- **Trash/quotas:** metadata soft-delete + a per-user `bytes_used` counter maintained transactionally; R2 listings (1000/page) for reconciliation; cron trigger for retention sweeps.
- **Ops:** reverse proxy (TLS), systemd/docker with restart and stop grace >40 s, `celld diagnose` in monitoring, OTLP or bucket telemetry, and a bucket backup policy (versioning or scheduled copy). Pin the celld version; read the release notes before every upgrade; expect some upgrades to require a full fleet stop.

### Biggest unknowns / decision points to ticket

1. **Durability posture and the open loss reports.** Choose single node + `CELLD_DURABILITY=bucket` (slower, simpler) vs 2+ node `fleet` (faster, but currently has open loss/wedge reports). If fleet: require stable `CELLD_NODE` IDs; define the exact outage/restart runbook (restart whole fleet together; witness grace), and a policy for `#244/#245/#250/#246/#239` before storing family data.
2. **Bucket choice and backup.** Qualified cloud store vs unqualified homelab MinIO; bucket versioning vs periodic copy; whether to back up node data dirs (required in fleet mode, because follower disks can hold un-uploaded acknowledged writes). Decide RPO/RTO targets and rehearse a restore.
3. **Upload protocol.** Define resumability above celld's limitations: chunk sizes, retry/restart semantics after node restart (multipart upload cannot resume), ordering, and the 1 GiB request cap. Decide whether uploads may touch multiple nodes at all.
4. **Metadata sharding.** DO-per-user vs D1-per-user vs KV + D1 directory; how listings paginate; how the global directory avoids a hot single writer; what the per-cell size ceiling is in practice (undocumented — must be tested).
5. **Secrets and key management.** No secret bindings today. Decide where JWT signing keys, share-link secrets, and any external API keys live (plain `vars` in the bucket? external KMS fetched at runtime? per-install generated?), and whether that is acceptable.
6. **Deletion and data-lifecycle guarantees.** Permanent purge isn't supported ([#175](https://github.com/denoland/celld/issues/175)); decide the retention/GC story (`CELLD_LTX_RETENTION_SECS`, R2 lifecycle rules, app-level encryption with key destruction) and a GDPR/"delete my account" position.
7. **Backup/restore and upgrades as a product feature.** Since there is no PITR and no backup tooling, ticket an operator runbook and version-pinning policy; include what happens to a running fleet during celld upgrades.
8. **Observability/alerting.** No metrics: decide OTLP collector + DuckDB-over-Parquet workflow, alert thresholds for self-fencing, restore backlog, memory pressure, and overload 503s.
9. **Scale test.** Verify users × files per node against the documented 1,000-resident-cells/8 GB figure (the landing page claims 2,500), isolate heap 128 MB, 64 concurrent events per cell, and cold-restore behaviour with multi-hundred-MB metadata DBs (page faults block the cell).
10. **Security boundary.** Keep the internal listener private; treat bucket credentials as fleet root; plan proxy-level protections (rate limits, body caps, TLS, auth) and how untrusted uploads are parsed for previews.

---

## Bottom line: can a self-hosted drive be built on celld today?

**Technically yes, with real caveats; operationally it is early-beta.** celld provides exactly the primitives a drive needs — a streaming R2 binding with ranges and multipart, per-user cells with SQLite, queues/workflows/cron for processing, and a self-host story of "binary + bucket + reverse proxy". The 1 GiB request cap, no presigned/public bucket access, multipart uploads pinned to one node with no resume, and unspecified per-cell size limits are solvable with a chunked upload/download design.

But the current beta has open, reproducible reports of **acknowledged-write loss and recovery wedges in the default fleet durability mode** (#244, #245, #250), plus disk growth and lease-fencing issues (#246, #239), no PITR, no cell purge, and no built-in backup. For a personal/family drive, that is a data-loss risk that must be mitigated by staying single-node with bucket durability, keeping independent backups of bucket *and* node data, pinning versions, and rehearsing restores. The substrate is promising and unusually well-engineered for its age, but a Nextcloud replacement on celld is a "build it now, treat durability as beta" proposition rather than a "deploy it and trust it with the only copy of the photos" proposition.

**Confidence:** high on celld's documented behavior (primary docs), high on the open-issue risk (primary issue tracker); medium on homelab performance (no primary benchmarks with local MinIO); unknown on per-cell DB size ceilings and per-request CPU enforcement.

---

## Open questions / risks (could not be resolved from primary sources)

1. **Maximum practical SQLite size per cell.** celld documents workerd SQL budgets for D1 but no max DB size; Cloudflare's reference is 10 GB. Whether celld can restore/handoff a 10 GB+ cell within its deadlines on homelab hardware is untested in any source I found.
2. **Per-request CPU limit** for celld Workers (Cloudflare uses 30 s). Not documented; only heap/transaction/deadline limits are.
3. **Homelab performance with local MinIO** (write latency, multipart throughput, restore paging) — no published measurements; MinIO explicitly unqualified for production.
4. **Whether the v0.6.0 loss/wedge issues affect single-node `bucket` durability.** The repros use fleets + fleet durability; a single node's path is different but shares the lease/recovery machinery. Unclear from the tracker.
5. **Secrets architecture** after [#190](https://github.com/denoland/celld/issues/190): how a deployed Worker reads an operator-provisioned secret is not documented.
6. **Whether multipart part-size rules (same size except last) are enforced by every underlying store** celld may use (MinIO/Ceph/GCS/Azure), or only by Cloudflare R2 — the celld docs defer to Cloudflare's rules but the bytes are written to the operator's store.
7. **No published limits/behavior for SSE long-lived connections** beyond the generic 60-s inactive stream rule.
8. **Long-term project governance:** PRs disabled, 12-commit history, Deno Land-controlled CLA; bus factor and community contribution model are unusual.
