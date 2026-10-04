# celld single-node durability verification

- **Wayfinder ticket #2** ("Verify celld single-node durability before committing the substrate"), map #1.
- Date: 2026-10-04. celld **v0.6.1**, pinned, installed via the official installer (`CELLD_VERSION=v0.6.1`); the release asset was verified with `gh attestation verify` (exit 0).
- Environment: Fedora 45 x86_64, 12 vCPU / 15 GB RAM; one node `labnode01` with `CELLD_DURABILITY=bucket`; local blob store **Azurite 3.37.0** (`--skipApiVersionCheck`); node watch dir on local disk.
- Method: a probe Worker deployed with `celld deploy`, driven by a write client that logs every acknowledgement; the server killed with `SIGKILL` mid-traffic and restarted on the same node id.

## Why Azurite, not MinIO

As of 2026-10-04, MinIO is not publicly obtainable: `docker.io/minio/minio` no longer exists (pull access denied), `quay.io/minio/minio` returns 401 anonymously, and the `dl.min.io` server/client binaries return HTTP 410. Azurite is a store celld explicitly supports as a dev backend (`AZURE_STORAGE_USE_EMULATOR=true`), so it served as the lab bucket. Separately, **SeaweedFS 4.48** (S3 mode, anonymous) passes the same `celld diagnose` contract test; **Garage** has moved off GitHub to `git.deuxfleurs.fr` and was not tested. This is evidence for the bucket-stack ticket: a "bundle MinIO" plan needs a different local store.

## Probe app

`durability-probe`: a Worker with a Durable Object (`Counter`, KV storage API) and a Queue (`probe-jobs`) with an idempotent consumer.

- `POST /w/:do {seq}` — one durable write (`storage.put`).
- `POST /w/:do/burst {start,count}` — a 100-key bulk `storage.put` (one commit).
- `GET /w/:do/status` — paged list; reports `count/min/max/missing`.
- `POST /jobs {n}` / `GET /q` — enqueue n messages / count processed (upsert by id, so duplicates dedupe).

The client logs every acknowledgement to JSONL. **Pass criterion: after restart, every acknowledged write is present and `missing: []`.**

## Results

| # | Scenario | What happened | Result |
|---|---|---|---|
| 1 | Storage contract | `celld diagnose` against Azurite | ok: conditional create, reject-create, update, reject-stale; 0 leases |
| 2 | `SIGKILL` ×3 during a continuous sequential stream | acked 272, 318, 365 writes (955 total; 6 pre-existing = 961) then killed mid-write each time; node served again in ~0.2–0.3 s each restart | after every restart all acked writes present; final `count=962 max=962 missing=[]` — the 962nd write was in flight at the last kill and committed anyway (unacked, allowed) |
| 3 | `SIGKILL` during 100-key bulk puts | 200 bursts (20,000 writes) before the kill all present after restart; then killed mid-burst at 15,700 acked writes | `count=35,800 max=35,800 missing=[]` — the in-flight burst committed too |
| 4 | `SIGKILL` ~1 s into queue consumption | 500 messages enqueued, node killed mid-batch | after restart the queue drained to exactly 500 processed, `missing=[]`; at-least-once + idempotent upsert held (no loss, duplicates deduped) |
| 5 | Local-state wipe restore | graceful stop; `rm -rf node-data` (46 MB); restart | alpha 962, beta 35,800, queue 500 — all `missing=[]` |
| 6 | Bucket-copy restore | copied 1,453 blobs to a new container (6.3 s); fresh node, fresh watch dir, new node id, new ports | same counts, all `missing=[]` |

Durable write latency (n=955): min 6 ms, **p50 8 ms, p95 12 ms**, p99 16 ms, max 182 ms (local Azurite, single node, bucket durability).

Also observed (not durability tests): `celld deploy` uploads a new version and nodes adopt it **in place without restart** (`POST /reload` forces adoption immediately); all of this ran while the node kept serving.

## What this establishes

- On celld v0.6.1, single node, `CELLD_DURABILITY=bucket`: **no acknowledged write was lost** across three mid-stream kills, a mid-burst kill, a mid-queue kill, a full local-state wipe, and a bucket-copy restore. Recoveries completed without wedging; the RPO=0 claim held for this path in these scenarios.
- Some unacknowledged in-flight writes can still land (the 962nd write; the in-flight burst). That direction is safe.
- The single-node path has no peers, so it never exercises the fleet-ensemble machinery behind the open loss reports (denoland/celld#244, #245, #250). This verification does not validate fleet mode — which v1 excludes anyway.

## What this does not establish

- Azurite is a dev store: it passes celld's storage contract, but this does not qualify it (or any store) operationally. Production posture remains qualified stores (R2/Tigris/S3/GCS/Azure) or a self-hosted store after its own soak.
- **Not tested:** bucket outage while running, node disk full, large-cell behaviour (the >256 MiB paged-restore path), long soak, upgrade path. Ticketed separately as the bad-day probe.
- Performance numbers are local-Azurite specific.

## Reproduction

Lab lived in `/tmp/opencode/celld-lab` (ephemeral). Shape:

- Install: `CELLD_INSTALL_ROOT=$PWD/celld-install CELLD_VERSION=v0.6.1 sh install.sh`
- Store: Azurite container with `--skipApiVersionCheck`; container `vinnodrive-lab` created with `@azure/storage-blob`
- Deploy: `AZURE_STORAGE_* CELLD_BUCKET=az://vinnodrive-lab celld deploy app`
- Run: `./start-node.sh` (node `labnode01`, listeners 127.0.0.1:8080/8081, `CELLD_DURABILITY=bucket`)
- Drive + kill: `node client.mjs stream alpha 1 100000 &` … `kill -9 $(cat node.pid)` … `./start-node.sh`, then compare the JSONL acks with `GET /w/alpha/status`
- Backup: `node azure-tool/copy.mjs vinnodrive-lab vinnodrive-lab-restore`

Scripts: `client.mjs`, `start-node.sh`, `stop-node.sh`, `azure-tool/copy.mjs`; probe app in `app/`.

## Verdict

Single-node celld with bucket durability behaved as documented under process kills, full local-state loss, and bucket-copy restore, on a store that passes celld's own contract test. **No durability blocker found** for adopting celld for v1 under the single-node `CELLD_DURABILITY=bucket` posture; the remaining verification axes (bucket outage, disk full, large cells) belong to the ops-spec track. Feeds **Decide: adopt celld for v1, and at what durability posture**.
