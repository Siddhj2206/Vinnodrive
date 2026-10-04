# Adopt celld as the v1 runtime, single node with bucket durability

**Status:** accepted (2026-10-04)

Vinnodrive v2 runs on **celld** (pinned; Apache-2.0, beta) as a Cloudflare-Workers-style application — Durable Object "cells", Queues, D1, R2 — because it gives a self-hosted single-binary + own-bucket deployment while matching the product's actor-shaped domain (per-space cells, live sync). v1 uses **one node** with **`CELLD_DURABILITY=bucket`**, which the kill/wipe/restore verification passed; fleet mode is unsupported in v1 because the open acknowledged-write-loss reports are all in the default fleet-durability path.

## Considered options

- **Simpler conventional substrate** (e.g. Bun/Hono + SQLite + local disk/S3) — more predictable today, but loses the actor model the product is designed around and the future fleet path.
- **Cloudflare-first, celld as experimental self-host** — a robust hosted path, but makes local self-hosting (the stated goal) second-class.
- **Fleet durability** — faster writes, but the open loss/wedge reports ([#244](https://github.com/denoland/celld/issues/244), [#245](https://github.com/denoland/celld/issues/245), [#250](https://github.com/denoland/celld/issues/250)) make it a bad fit for v1.

## Policy attached to this decision

- **Pinning:** compose pins an exact celld version; supported window is N and N−1; CI smoke-tests the window and an upgrade of a restored fleet; security releases adopted on a short clock; upgrades are stop-the-world for a single node.
- **Backups:** operator backup script + documented restore drill; targets: RPO=0 for acknowledged writes while healthy, DR RPO = last bucket backup, RTO ≈ small-fleet restore (measured ~6s for 1.4k objects). Docs state plainly: you own the bucket, back it up; celld is beta.
- **Reconsideration triggers:** unmitigated data-loss reports in our posture, upstream stalls security fixes or abandons the project, or a required capability proves impossible. Bug policy: in-app workaround first, then an upstream patch by email; fork only for a blocking correctness fix upstream won't take.

## Consequences

- The app brings its own auth, sessions and secrets handling (celld has none, and no secret store).
- TLS is terminated by an ingress proxy we ship (Caddy).
- A bucket is mandatory even on one machine. MinIO is no longer publicly distributable; Azurite and SeaweedFS pass celld's contract test, with qualified stores (R2/Tigris/S3/GCS/Azure) as the production recommendation.
- Every file byte flows through the Worker (no presigned URLs); uploads are chunked.
- The design stays Cloudflare-compatible where free, keeping a portable/hosted path open.

## References

- [celld substrate findings](https://github.com/Siddhj2206/Vinnodrive/blob/research/celld-substrate/docs/research/celld-substrate.md)
- [Single-node durability verification](https://github.com/Siddhj2206/Vinnodrive/blob/research/celld-verification/docs/research/celld-verification.md)
- [Map](https://github.com/Siddhj2206/Vinnodrive/issues/1) · [Ticket](https://github.com/Siddhj2206/Vinnodrive/issues/6)
