# Research: auth and sessions in the celld/workerd environment

- **Wayfinder ticket:** #3 — "Research: auth and sessions in the workerd/celld environment" (map issue #1)
- **Date:** 2026-10-04
- **Status:** findings complete; recommendation at the end
- **Method:** primary sources only (celld docs/source/issue tracker, better-auth docs/source/npm metadata, library repos, OWASP, JSR). No celld instance was run; verification steps are listed as open questions.

---

## 1. Executive summary

For Vinnodrive v2 on celld, **Better Auth (1.7.x) with a D1 database is the only mature, feature-complete option that explicitly targets Cloudflare Workers and D1**, but it cannot be used stock:

1. **Better Auth's default password hashing is broken on celld.** Better Auth hashes passwords with `scrypt` by default ([security reference](https://www.better-auth.com/docs/reference/security)). Under the `workerd`/`node` export conditions, `@better-auth/utils@0.4.2` resolves `password.node.mjs`, which calls `scrypt` from `node:crypto` ([package.json](https://unpkg.com/@better-auth/utils@0.4.2/package.json), [password.node.mjs](https://unpkg.com/@better-auth/utils@0.4.2/dist/password.node.mjs)). celld explicitly ships `scrypt: notImplemented("scrypt")` and `scryptSync: notImplemented("scryptSync")` ([`node_crypto.js`](https://github.com/denoland/celld/blob/main/crates/celld/js/node_crypto.js)). The default path must be overridden with a custom `password.hash`/`password.verify` before the first user exists.
2. **PBKDF2 is the safest supported primitive.** celld implements PBKDF2 and HKDF natively in both Web Crypto ([`crypto.js`](https://github.com/denoland/celld/blob/main/crates/celld/js/crypto.js)) and `node:crypto` ([workspace Cargo.toml comment: "The two node:crypto KDFs" — `pbkdf2`, `hkdf`](https://github.com/denoland/celld/blob/main/Cargo.toml)). Recommended: PBKDF2-HMAC-SHA-256 at 600,000 iterations, or Argon2id via WASM if OWASP-first is preferred ([OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)).
3. **D1 is the right session/user store.** Better Auth merged built-in D1 support (auto-detection, Kysely dialect) on 2026-02-28 ([PR #7519](https://github.com/better-auth/better-auth/pull/7519)) and documents `database: env.DB` ([database docs](https://www.better-auth.com/docs/concepts/database)). celld D1 supports `batch()` as the transaction primitive, one writer per database, and no interactive transactions ([celld D1 docs](https://github.com/denoland/celld/blob/main/docs/services/d1.md)); Better Auth's Kysely adapter uses transactions only when explicitly enabled (`transaction` defaults to `false`) ([kysely-adapter.ts](https://github.com/better-auth/better-auth/blob/main/packages/kysely-adapter/src/kysely-adapter.ts)).
4. **Secrets are the biggest operational gap.** celld has no secret store ([issue #190](https://github.com/denoland/celld/issues/190), open) and removed `CELLD_VAR_*` / `CELLD_VARS_FILE` in 0.5.0 ([issue #219](https://github.com/denoland/celld/issues/219), [issue #190 comment](https://github.com/denoland/celld/issues/190#issuecomment-5722027976)). `.dev.vars` is read only by `celld dev` ([docs/README.md](https://github.com/denoland/celld/blob/main/docs/README.md)). `vars` in the Wrangler config is the only deploy-time value channel ([cloudflare-compat.md](https://github.com/denoland/celld/blob/main/docs/cloudflare-compat.md)). The deployment pipeline must inject the auth secret into a generated `wrangler.json`, or the app must read a secret object from the fleet bucket through an R2 binding ([R2 docs](https://github.com/denoland/celld/blob/main/docs/services/r2.md)).
5. **Ecosystem churn eliminates the alternatives:** Lucia was deprecated in March 2025 ([lucia-auth.com](https://lucia-auth.com/)), oslo is archived/deprecated ([oslo repo](https://github.com/pilcrowonpaper/oslo)), and Arctic was deprecated in July 2026 ([Arctic README](https://github.com/pilcrowonpaper/arctic)). OpenAuth is the remaining self-hosted Workers-native alternative, but it is a beta, separate OAuth issuer service ([OpenAuth README](https://github.com/anomalyco/openauth)). Vinnodrive v1 already uses Better Auth ([repo README](../../README.md)), so the team's operational knowledge transfers.

**Recommendation in one line:** Better Auth pinned to an exact 1.7.x version, D1-backed, custom PBKDF2 password hashing, invite-only onboarding with hand-delivered invite links (no email on celld), API tokens via the api-key plugin, secrets injected at deploy time by the deployment pipeline, and a celld smoke-test suite (signup, login, session read, revocation, API key, migration) run under `celld dev` in CI.

---

## 2. Constraints of the celld environment

### 2.1 Runtime and Node compatibility

- celld runs Workers, Durable Objects, KV, Queues, D1, R2, Workflows, Cron Triggers, and static assets from a `wrangler.json`; it is self-hosted and beta (v0.6.1 at the time of writing) ([celld README](https://github.com/denoland/celld)).
- celld is **not safe for hostile multi-tenant use**; the fleet trusts application code and operators ([security.md](https://github.com/denoland/celld/blob/main/docs/security.md)).
- Node.js compatibility is **partial**. celld implements `node:assert`, `node:async_hooks`, `node:buffer`, `node:diagnostics_channel`, `node:events`, `node:fs`, `node:os`, `node:path`, `node:stream`, `node:timers/promises`, and `node:util`; `node:crypto` exists but "does not implement Diffie-Hellman, streaming signatures, ciphers, RSA-PSS, or DSA signatures and key generation" ([cloudflare-compat.md](https://github.com/denoland/celld/blob/main/docs/cloudflare-compat.md)).
- Better Auth on Workers asks for `nodejs_compat` or `nodejs_als` for `AsyncLocalStorage` ([installation docs, Cloudflare Workers tab](https://www.better-auth.com/docs/installation)). celld accepts unknown compatibility flags without effect and always provides its `node:*` built-ins, including `node:async_hooks` ([cloudflare-compat.md](https://github.com/denoland/celld/blob/main/docs/cloudflare-compat.md); [`node_async_hooks.js`](https://github.com/denoland/celld/blob/main/crates/celld/js/node_async_hooks.js)).
- Known celld runtime gap relevant to auth libraries: `node:crypto` lacks ciphers, `createSign`/`createVerify`, and classic key generation; those entry points throw loudly rather than silently ([`node_crypto.js`](https://github.com/denoland/celld/blob/main/crates/celld/js/node_crypto.js), lines defining `createCipheriv`, `createSign`, `scrypt`, etc.).
- Web Crypto is "Yes" with celld-specific differences: HMAC MD5/SHA-1/224/256/384/512; ECDSA **P-256 with SHA-256 only**; AES-GCM tags 96–128 bits in 8-bit steps; RSA-OAEP with SHA-1/256/384/512; Ed25519 and X25519; `timingSafeEqual` is available as a non-standard extension ([cloudflare-compat.md](https://github.com/denoland/celld/blob/main/docs/cloudflare-compat.md), [Cloudflare Web Crypto table](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)).
- Source-level confirmation (`crates/celld/js/crypto.js`): PBKDF2 and HKDF via `$$pbkdf2`/`$$hkdf`; AES-GCM, AES-CBC, AES-CTR; HMAC; ECDSA P-256/SHA-256; RSA-PSS sign/verify; Ed25519 sign/verify; `DigestStream` buffering in memory ([crypto.js](https://github.com/denoland/celld/blob/main/crates/celld/js/crypto.js)).
- WebAssembly imports work (`rules: CompiledWasm`, `no_bundle` discovery of `**/*.wasm`), which makes WASM Argon2/scrypt viable ([wasm docs](https://github.com/denoland/celld/blob/main/docs/wasm.md)).
- The V8 heap limit defaults to 128 MB per isolate and is configurable with `CELLD_V8_HEAP_LIMIT_MB` ([celld README](https://github.com/denoland/celld)). Memory-hard hashing inside an isolate must fit that budget.
- No Workers AI, Vectorize, Hyperdrive, Browser Rendering, **Email Workers**, or BroadcastChannel; Cache is always-miss ([cloudflare-compat.md](https://github.com/denoland/celld/blob/main/docs/cloudflare-compat.md)).

### 2.2 Storage primitives and their auth-relevant semantics

**D1** (recommended primary store):
- One database is one cell: a single-threaded actor with its own SQLite file, owned by exactly one node; every query leaves the Worker isolate and dispatches to the owner node ([D1 docs](https://github.com/denoland/celld/blob/main/docs/services/d1.md)).
- `batch()` runs statements in one `BEGIN IMMEDIATE ... COMMIT`; application SQL cannot open its own transaction (`BEGIN`/`COMMIT`/`SAVEPOINT` denied) ([D1 docs](https://github.com/denoland/celld/blob/main/docs/services/d1.md)).
- One writer per database; more write capacity means more databases, not more nodes ([D1 docs](https://github.com/denoland/celld/blob/main/docs/services/d1.md)).
- No read replicas; every read observes every committed write; `withSession()` always selects the primary, `getBookmark()` returns `celld:primary` ([D1 docs](https://github.com/denoland/celld/blob/main/docs/services/d1.md)).
- celld ships `celld d1 migrations apply` against a deployed database ([celld README](https://github.com/denoland/celld)).
- A prepared statement is a single statement; `exec()` counts statements, `batch()` returns one result per statement ([D1 docs](https://github.com/denoland/celld/blob/main/docs/services/d1.md)).

**KV**:
- A namespace is one cell; every call reaches the owner node, and **a celld read is never stale** (unlike Cloudflare KV) ([KV docs](https://github.com/denoland/celld/blob/main/docs/services/kv.md)).
- One writer per namespace; `expirationTtl` minimum lifetime is 60 seconds; values >1 MiB go to the fleet bucket ([KV docs](https://github.com/denoland/celld/blob/main/docs/services/kv.md)).
- Reads and writes each cost one cell dispatch; writes pay full durability ([KV docs](https://github.com/denoland/celld/blob/main/docs/services/kv.md)).

**Durable Objects ("cells")**:
- Single-threaded actor with SQLite storage, transactions (`transaction()`, `transactionSync()`), alarms, an output gate that holds responses until writes are durable, and per-object hosting ([DO docs](https://github.com/denoland/celld/blob/main/docs/services/durable-objects.md)).
- A cell can hibernate/inactivate, so only durable storage persists across events ([DO docs](https://github.com/denoland/celld/blob/main/docs/services/durable-objects.md)).
- Transactions and `blockConcurrencyWhile()` have a 30-second limit ([DO docs](https://github.com/denoland/celld/blob/main/docs/services/durable-objects.md)).

**R2**:
- An `r2_buckets` binding serves the **fleet bucket** under `r2/<bucket_name>/`; there is no public bucket URL and no S3 endpoint into a binding ([R2 docs](https://github.com/denoland/celld/blob/main/docs/services/r2.md)).
- This is the only application-writable, non-config persistent store outside D1/KV/DO, and it is reachable both from the Worker (binding) and from the operator CLI (`celld r2 put`) ([R2 docs](https://github.com/denoland/celld/blob/main/docs/services/r2.md), [celld README](https://github.com/denoland/celld)).

### 2.3 Secrets, vars, and email

- **No secret store.** `celld secret put` does not exist; issue [#190](https://github.com/denoland/celld/issues/190) is open (opened 2026-09-09, two "+1" comments, updated 2026-09-30). The request text: "So we don't have to put secret in wrangler.json" ([issue #190](https://github.com/denoland/celld/issues/190)).
- `CELLD_VAR_*` and `CELLD_VARS_FILE`, the previous per-node/environment override, were **removed in 0.5.0** and are now hard failures ([issue #219](https://github.com/denoland/celld/issues/219), [issue #190 comment](https://github.com/denoland/celld/issues/190#issuecomment-5722027976)).
- `.dev.vars` is read only by `celld dev`; "Only `celld dev` reads the file, so a local credential does not reach a fleet through `celld deploy`" ([docs/README.md](https://github.com/denoland/celld/blob/main/docs/README.md)).
- The deployed Worker `env` comes from the Wrangler config's `vars` (accepted by `celld deploy`) plus bindings ([cloudflare-compat.md](https://github.com/denoland/celld/blob/main/docs/cloudflare-compat.md), [docs/README.md](https://github.com/denoland/celld/blob/main/docs/README.md)).
- The fleet bucket "is the root of authority for the fleet" and its credentials grant full control; the application should treat bucket access as operator access ([security.md](https://github.com/denoland/celld/blob/main/docs/security.md)).
- **No email binding.** Email Workers are "No" ([cloudflare-compat.md](https://github.com/denoland/celld/blob/main/docs/cloudflare-compat.md)). Any verification/reset mail must go through an outbound `fetch` to a third-party email API (outbound fetch is supported), or be replaced with link/code display flows.
- celld does not terminate TLS and does not verify hostnames/proxies. `X-Forwarded-Host`/`X-Forwarded-Proto` are ignored unless `--trust-forwarded-headers` is set; the `Host` header is not trustworthy without a trusted proxy ([security.md](https://github.com/denoland/celld/blob/main/docs/security.md)). Its own guidance: "The public listener — terminate TLS and authenticate users in a proxy or the application" ([security.md](https://github.com/denoland/celld/blob/main/docs/security.md)).

---

## 3. Auth libraries for workerd/celld

### 3.1 Better Auth — the only full-featured candidate (with integration work)

- **Runtime support:** the installation docs include an explicit Cloudflare Workers tab and recommend `nodejs_compat`/`nodejs_als` for `AsyncLocalStorage` ([installation docs](https://www.better-auth.com/docs/installation)). Current release examined: **1.7.7** ([npm package.json](https://unpkg.com/better-auth/package.json)). Runtime dependencies include `@noble/ciphers`, `@noble/hashes`, `jose`, `kysely`, and a pinned `@better-auth/utils` ([npm package.json](https://unpkg.com/better-auth/package.json)), i.e. pure-JS crypto where it matters.
- **D1 support:** built-in `D1Database` support was merged into canary on 2026-02-28 ([PR #7519](https://github.com/better-auth/better-auth/pull/7519)); the docs now show `database: env.DB` and a programmatic `getMigrations()` route for Workers ([database docs](https://www.better-auth.com/docs/concepts/database)). The D1 dialect implements `executeQuery` with `prepare().bind().all()`, detects D1 by `batch`/`exec`/`prepare`, and throws a descriptive error for interactive transactions ([d1-sqlite-dialect.ts](https://github.com/better-auth/better-auth/blob/main/packages/kysely-adapter/src/d1-sqlite-dialect.ts)).
- **Transactions:** the Kysely adapter uses `db.transaction()` only when the adapter config sets `transaction: true`; the default is `false`, so operations run sequentially and D1 does not need interactive transactions ([kysely-adapter.ts](https://github.com/better-auth/better-auth/blob/main/packages/kysely-adapter/src/kysely-adapter.ts)).
- **Known Workers friction (recent history, verify current status):**
  - v1.3.8 beta bundled `os`, `path`, `node:sqlite` and emitted Cloudflare build warnings; fixed by PR #4415 ([issue #4404](https://github.com/better-auth/better-auth/issues/4404)).
  - `@better-auth/utils` previously lacked a `workerd` export condition, so Workers bundled the pure-JS `@noble/hashes` scrypt fallback instead of the node implementation; fixed by adding the condition ([issue #9649](https://github.com/better-auth/better-auth/issues/9649), [utils@0.5.0 package.json](https://unpkg.com/@better-auth/utils/package.json), and already present in the pinned [utils@0.4.2 package.json](https://unpkg.com/@better-auth/utils@0.4.2/package.json)).
  - Historical D1 setup guides required wrapping Kysely manually and re-creating the auth instance per request because bindings are only available in the request context ([discussion #7487](https://github.com/better-auth/better-auth/discussions/7487)); the built-in D1 support plus celld's `env` argument make the per-request instantiation straightforward but still required (module-scope auth instance cannot see `env.DB`).
- **Feature coverage needed by v2** — all present:
  - Email/password with custom `password.hash`/`password.verify` ([options reference](https://www.better-auth.com/docs/reference/options)).
  - Server-side sessions with expiration, refresh, freshness, revocation (single, other, all) and cookie caching ([session docs](https://www.better-auth.com/docs/concepts/session-management)).
  - Session/verification/rate-limit offload via a 5-method `secondaryStorage` interface (`get`, `getAndDelete`, `increment`, `set`, `delete`) ([database docs](https://www.better-auth.com/docs/concepts/database)).
  - API keys with hashing, prefixes, expiry, rate limiting, metadata, multiple configurations, org-owned keys ([api-key docs](https://www.better-auth.com/docs/plugins/api-key), [advanced](https://www.better-auth.com/docs/plugins/api-key/advanced), [reference](https://www.better-auth.com/docs/plugins/api-key/reference)). Default hashing is **SHA-256 → base64url** via `defaultKeyHasher` ([source](https://github.com/better-auth/better-auth/blob/fd6b8c13/packages/api-key/src/index.ts)).
  - Organizations/invitations with a `sendInvitationEmail` callback that constructs the invite link ([organization docs](https://www.better-auth.com/docs/plugins/organization)).
  - Passkeys via SimpleWebAuthn ([passkey docs](https://www.better-auth.com/docs/plugins/passkey)).
  - Built-in CSRF defenses: origin validation against `trustedOrigins`, Fetch Metadata checks, `SameSite=Lax` cookies, no mutations on GET, and first-login CSRF protection ([security reference](https://www.better-auth.com/docs/reference/security)).
  - Versioned secret rotation (`secrets` / `BETTER_AUTH_SECRETS`) ([options reference](https://www.better-auth.com/docs/reference/options), [security reference](https://www.better-auth.com/docs/reference/security)).
  - Rate limiting with storage `"memory" | "database" | "secondary-storage"` ([options reference](https://www.better-auth.com/docs/reference/options)).

### 3.2 Lucia — deprecated, do not start here

- "Lucia was deprecated in March 2025" and replaced by a single-file implementation (`code/auth_session.ts`) plus the Auth Book ([lucia-auth.com](https://lucia-auth.com/), [Auth Book](https://auth.pilcrowonpaper.com)).
- The Copenhagen/Auth Book model — random session tokens, SHA-256 token hashes in DB, `HttpOnly`/`SameSite=Lax`/`Secure` cookies — remains a valid **fallback design** if the Better Auth integration proves unworkable, but it means owning sessions, tokens, CSRF, password resets, and OAuth yourself.

### 3.3 Oslo / OsloJS — deprecated or split

- `pilcrowonpaper/oslo` was archived on 2025-01-20; the README says it is deprecated and points to packages under [oslojs.dev](https://oslojs.dev) ([repo](https://github.com/pilcrowonpaper/oslo)).
- The old README notes that "Aside from `oslo/password`, every module works in any environment, including Node.js, Cloudflare Workers, Deno, and Bun" — the password module was the exception because it needed Node crypto ([repo README](https://github.com/pilcrowonpaper/oslo)). Using `@oslojs/crypto`-style helpers in 2026 is possible, but the ecosystem's auth stewardship has moved to the Auth Book pattern.

### 3.4 Arctic — deprecated

- "Arctic was deprecated on July 2026. Some example code (with comments) to replace the package can be found under /code." ([Arctic README](https://github.com/pilcrowonpaper/arctic)). Do not build OAuth clients on it.

### 3.5 OpenAuth — viable alternative, different shape

- "Universal, standards-based auth provider… runs entirely on your infrastructure… Cloudflare Workers"; it is **currently in beta**; it is a centralized OAuth 2.0 issuer service built on Hono, with KV/DynamoDB storage for minimal state (refresh tokens, password hashes) ([OpenAuth README](https://github.com/anomalyco/openauth)).
- Trade-off: it does not solve user management (you supply `success` callback logic), and it introduces a second deployable surface. For a single self-hosted workspace product, Better Auth keeps auth in-process and avoids the second service.

### 3.6 SimpleWebAuthn (passkeys) — works on Workers per JSR, with an edge-runtime caveat

- JSR states: "This package works with Cloudflare Workers, Node.js, Deno, Bun" ([JSR](https://jsr.io/@simplewebauthn/server)). The changelog lists CloudFlare Workers as "periodically tested but unofficially supported" ([CHANGELOG](https://raw.githubusercontent.com/MasterKale/SimpleWebAuthn/master/CHANGELOG.md)).
- Better Auth 1.7.7's passkey plugin depends on `@simplewebauthn/server ^13.3.1` ([package.json](https://unpkg.com/@better-auth/passkey/package.json)). That version depends on `@peculiar/x509 ^1.14.3` ([package.json](https://unpkg.com/@simplewebauthn/server@13.3.1/package.json)), and `@peculiar/x509@1.14.3` pulls in `tsyringe` and `reflect-metadata` ([package.json](https://unpkg.com/@peculiar/x509@1.14.3/package.json)).
- That dependency chain has a documented edge-runtime failure: "`tsyringe` requires a `reflect-metadata` polyfill" on Cloudflare Workers/edge, affecting `@simplewebauthn/server` via `@better-auth/passkey`, with a community patch for Nuxt/workerd setups ([x509 issue #116](https://github.com/PeculiarVentures/x509/issues/116), [patch example](https://github.com/onmax/nuxt-better-auth/blob/main/patches/@peculiar__x509@1.14.2.patch)). Standard Wrangler bundling includes `reflect-metadata`, so the failure is bundler-dependent; celld's esbuild pipeline needs a smoke test.
- celld supports the Web Crypto algorithms passkeys need: ECDSA P-256/SHA-256 (the common ES256), Ed25519, and RSASSA-PKCS1-v1_5 ([crypto.js](https://github.com/denoland/celld/blob/main/crates/celld/js/crypto.js), [cloudflare-compat.md](https://github.com/denoland/celld/blob/main/docs/cloudflare-compat.md)).

---

## 4. Crypto reality check: what password hashing can actually run on celld

| Primitive | celld support | Evidence |
|---|---|---|
| PBKDF2 (Web Crypto + node:crypto) | **Yes** | `$$pbkdf2` in [`crypto.js`](https://github.com/denoland/celld/blob/main/crates/celld/js/crypto.js); `pbkdf2`/`pbkdf2Sync` exported in [`node_crypto.js`](https://github.com/denoland/celld/blob/main/crates/celld/js/node_crypto.js); `pbkdf2` crate in [workspace Cargo.toml](https://github.com/denoland/celld/blob/main/Cargo.toml) ("The two node:crypto KDFs") |
| HKDF | **Yes** | same sources (`$$hkdf`, `hkdf`/`hkdfSync`) |
| scrypt (node:crypto) | **No — throws** | `scrypt: notImplemented("scrypt")`, `scryptSync: notImplemented("scryptSync")` in [`node_crypto.js`](https://github.com/denoland/celld/blob/main/crates/celld/js/node_crypto.js) |
| Argon2 (node:crypto) | **No** | Cloudflare also excludes it ([Cloudflare node:crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)); celld has no argon2 crate ([Cargo.toml](https://github.com/denoland/celld/blob/main/Cargo.toml)) |
| scrypt / Argon2 in pure JS (`@noble/hashes`) | Yes (CPU-heavy) | Pure JS has no host dependency; Better Auth's fallback path bundles it ([utils password.mjs](https://unpkg.com/@better-auth/utils@0.4.2/dist/password.mjs)) |
| Argon2/scrypt via WASM | Yes | WebAssembly modules are supported and compiled once per process ([wasm docs](https://github.com/denoland/celld/blob/main/docs/wasm.md)) |
| AES-GCM / AES-CBC / AES-CTR | Yes | [`crypto.js`](https://github.com/denoland/celld/blob/main/crates/celld/js/crypto.js) |
| HMAC-SHA-256 (cookie signing, TOTP) | Yes | [`crypto.js`](https://github.com/denoland/celld/blob/main/crates/celld/js/crypto.js) |
| `timingSafeEqual` | Yes (non-standard Web Crypto extension) | [`crypto.js`](https://github.com/denoland/celld/blob/main/crates/celld/js/crypto.js); note celld's compat page lists no exception for it |

**What this means for Better Auth:** its default `scrypt` must be replaced or forced onto the pure-JS fallback. The fallback (`@noble/hashes` scrypt, N=16384, r=16, dkLen=64 per the node variant's config) is memory-hard but CPU-heavy in JS and happens to use ~32 MiB per hash ([password.node.mjs](https://unpkg.com/@better-auth/utils@0.4.2/dist/password.node.mjs) for parameters; [password.mjs](https://unpkg.com/@better-auth/utils@0.4.2/dist/password.mjs) for the fallback). Relying on which export condition celld's esbuild resolves is fragile; **override the hash explicitly**.

**Recommended password hash for v2:** `PBKDF2-HMAC-SHA-256`, 600,000 iterations, 16-byte random salt, 32-byte output, stored in a PHC-style string, verified with `crypto.subtle.timingSafeEqual` or a constant-time comparison. This matches OWASP's PBKDF2 guidance and uses only primitives celld implements natively ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)). Work-factor tuning should target well under one second per login on the target fleet ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)).

**Optional stronger option:** Argon2id via a WASM build (`hash-wasm` or equivalent), m=19 MiB, t=2, p=1, per OWASP. This is OWASP's first choice and celld supports WASM. Costs: an extra dependency, per-isolate WASM memory (fits the 128 MB V8 heap), and one more thing to smoke-test. Recommend PBKDF2 for v2.0 and revisit Argon2 later.

**Pepper:** OWASP recommends a pepper stored separately from the database ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)). On celld, "separately" realistically means either the deploy-time secret channel or the R2 secret object. Add after the secret-delivery decision.

---

## 5. Sessions: storage, rotation, revocation, CSRF

### 5.1 Better Auth's session model

- Server-side session rows (`session.token` is the opaque cookie value) stored in the database by default, with `expiresIn` (7 days default), `updateAge` (1 day), and `freshAge` (1 day) ([session docs](https://www.better-auth.com/docs/concepts/session-management)).
- Revocation APIs: `revokeSession`, `revokeOtherSessions`, `revokeSessions`, plus revoke-on-password-change ([session docs](https://www.better-auth.com/docs/concepts/session-management)).
- Cookie cache can store signed session data client-side (strategies `compact` = base64url + HMAC-SHA256, `jwt` = HS256, `jwe` = A256CBC-HS512 with HKDF) to avoid a DB read per `getSession` ([session docs](https://www.better-auth.com/docs/concepts/session-management)). Revocation is delayed up to `maxAge` while the cache lives ([session docs](https://www.better-auth.com/docs/concepts/session-management)).
- Stateless sessions (no DB) exist but remove the user/account tables, which a workspace product with passwords needs ([session docs](https://www.better-auth.com/docs/concepts/session-management)).

### 5.2 Storage options on celld, compared

| Option | Consistency on celld | Cost per session op | Revocation | Fit |
|---|---|---|---|---|
| **D1 (primary DB)** | Strong; one writer, no stale reads ([D1 docs](https://github.com/denoland/celld/blob/main/docs/services/d1.md)) | One cell dispatch + durable write for refresh/revoke; reads also dispatch | Immediate when cookie cache disabled | **Recommended default.** One auth database cell; keep it separate from product D1 usage |
| **D1 + cookie cache (compact)** | Cache is client-side; DB is source of truth | DB hit only on cache miss/refresh | Delayed up to `maxAge` while cache is valid ([session docs](https://www.better-auth.com/docs/concepts/session-management)) | **Recommended tuning**: short `maxAge` (30–120 s) keeps revocation responsive while cutting dispatches |
| **KV as `secondaryStorage`** | Strong; celld KV has no stale reads ([KV docs](https://github.com/denoland/celld/blob/main/docs/services/kv.md)) | One cell dispatch per op; writes pay durability; TTL minimum 60 s | Immediate for token delete (no cookie cache) | Works, but it is a second single-writer cell and splits auth state; no advantage over D1 at this scale |
| **DO as `secondaryStorage`** | Strongest; per-key/per-user sharding removes the single-writer bottleneck ([DO docs](https://github.com/denoland/celld/blob/main/docs/services/durable-objects.md)) | One dispatch per op to the owning DO; shardable | Immediate | Best future scaling path; requires implementing the 5-method `SecondaryStorage` interface ([database docs](https://www.better-auth.com/docs/concepts/database)) over DO stubs/RPC. Not needed for v2.0 |
| **Stateless signed cookies only** | N/A | No store | Rotation by version bump invalidates all sessions ([session docs](https://www.better-auth.com/docs/concepts/session-management)) | Not suitable: users/accounts still need persistence |

**Rotation:** Better Auth refreshes `expiresAt` when a session is used past `updateAge` ([session docs](https://www.better-auth.com/docs/concepts/session-management)). Secret rotation for encrypted material is supported via the versioned `secrets` option ([options reference](https://www.better-auth.com/docs/reference/options)). Opener-token rotation (session fixation defense) is implicit in the sign-in flow; on password change, `revokeOtherSessions: true` is the documented control ([session docs](https://www.better-auth.com/docs/concepts/session-management)).

**Revocation:** for a self-hosted workspace, D1 writes with cookie cache disabled (or a very short cache) give immediate, explainable revocation. If cookie cache is enabled, expose "sign out everywhere" as a `disableCookieCache`/short-cache operation, per the docs' own caveat.

### 5.3 CSRF

Better Auth includes layered CSRF protection out of the box ([security reference](https://www.better-auth.com/docs/reference/security)):
- state-changing operations prefer non-simple requests (JSON content type / custom header);
- `Origin` header validation against `trustedOrigins` (defaults to `baseURL`);
- `SameSite=Lax` session cookies, `HttpOnly`, `Secure` when the base URL is https;
- Fetch Metadata checks for first-login CSRF on form-postable routes;
- no mutations on GET except callback routes with `state`/`nonce` validation.

celld-side requirements:
- Set `baseURL` explicitly (https) rather than letting it be inferred; the options docs warn against request inference ([options reference](https://www.better-auth.com/docs/reference/options)).
- Keep `trustedOrigins` exact; do not enable `advanced.trustedProxyHeaders` unless the ingress proxy sets and overwrites `X-Forwarded-Host`/`X-Forwarded-Proto`, because celld ignores those headers by default and rejects unverified hosts ([security.md](https://github.com/denoland/celld/blob/main/docs/security.md), [security reference](https://www.better-auth.com/docs/reference/security)).
- Configure `advanced.ipAddress.ipAddressHeaders` (and `trustedProxies` if behind a chain) so rate limiting cannot be bypassed by client-set `X-Forwarded-For` ([options reference](https://www.better-auth.com/docs/reference/options), [security reference](https://www.better-auth.com/docs/reference/security)); celld exposes no trustworthy client IP itself.
- Because celld's `Request.cf` has no edge fields, do not build any auth decision on `cf` ([cloudflare-compat.md](https://github.com/denoland/celld/blob/main/docs/cloudflare-compat.md)).

---

## 6. Invite links, API tokens, and app passwords

### 6.1 Invites without email

- Better Auth's organization plugin supports invitations with `sendInvitationEmail(data)` where you construct `https://app/accept-invitation/<id>` yourself ([organization docs](https://www.better-auth.com/docs/plugins/organization)).
- Without celld email, the flow becomes: create invitation → the callback surfaces the link (or writes it to a table/D1) → an owner copies/shares it out of band → the invitee signs in with the invited email and calls `acceptInvitation` ([organization docs](https://www.better-auth.com/docs/plugins/organization)).
- Security guidance from the same docs: invitation IDs are "action-capable" — `listInvitations` exposes them, so restrict that endpoint or enable `requireEmailVerificationOnInvitation` when IDs could leak ([organization docs](https://www.better-auth.com/docs/plugins/organization)). Email verification cannot be completed on celld without an external email provider; for invite-only onboarding, prefer that only the inviter can read the link and treat links as one-time secrets.
- Password reset/verification hooks (`sendResetPassword`, `sendVerificationEmail`) also receive a `url`; with no email, capture the URL and deliver it by the same admin-channel flow, or integrate an external email API later ([options reference](https://www.better-auth.com/docs/reference/options)).

### 6.2 API tokens and app passwords

- The `@better-auth/api-key` plugin provides user-owned and org-owned keys, prefixes, expiry, remaining/refill, per-key sliding-window rate limiting, permissions, metadata, and multiple configurations ([api-key docs](https://www.better-auth.com/docs/plugins/api-key), [reference](https://www.better-auth.com/docs/plugins/api-key/reference)).
- **Keys are hashed by default with SHA-256** (base64url), and `disableKeyHashing` is explicitly warned against; SHA-256 is appropriate for high-entropy random tokens ([reference](https://www.better-auth.com/docs/plugins/api-key/reference), [source](https://github.com/better-auth/better-auth/blob/fd6b8c13/packages/api-key/src/index.ts)).
- Storage modes: database (default), secondary storage, or secondary-with-fallback; secondary storage uses TTL'd keys like `api-key:${hashedKey}` ([reference](https://www.better-auth.com/docs/plugins/api-key/reference)).
- `enableSessionForAPIKeys` can make a valid key behave as a session for all endpoints, with a documented impersonation warning; for a programmable surface, verifying keys explicitly and scoping permissions is safer ([advanced](https://www.better-auth.com/docs/plugins/api-key/advanced), [reference](https://www.better-auth.com/docs/plugins/api-key/reference)).
- Model "app passwords" as a separate `configId` with a distinct prefix (e.g. `vnd_app_`) and tighter permissions; the multi-configuration feature exists exactly for public-vs-secret, read-only-vs-read-write key classes ([advanced](https://www.better-auth.com/docs/plugins/api-key/advanced)).

### 6.3 Rate limiting

- Better Auth rate limiting defaults to `storage: "memory"` ([options reference](https://www.better-auth.com/docs/reference/options)). On celld, module-scope memory is per-isolate and isolates are retired/moved; a multi-node fleet would enforce limits per isolate ([workers docs](https://github.com/denoland/celld/blob/main/docs/services/workers.md)). Use `storage: "database"` (or `"secondary-storage"`) for global limits ([options reference](https://www.better-auth.com/docs/reference/options)).
- API-key rate limiting stores counters on the key row (database) by default, so it is fleet-wide ([advanced](https://www.better-auth.com/docs/plugins/api-key/advanced)).
- celld itself imposes a per-DO concurrent-request cap (64 by default, `CELLD_MAX_CELL_REQUESTS`) and returns 503 with `Retry-After: 1` ([celld README](https://github.com/denoland/celld)). Auth endpoints should handle 503 gracefully.

---

## 7. Secret management on celld (the #190 problem)

celld currently offers no secret primitive. The realistic options:

1. **Deploy-time injection (recommended for v2.0).** Keep the real `wrangler.json` out of git; generate it in the deployment pipeline from the operator's secret manager (1Password/`op inject`, SOPS, CI secrets, etc.) and run `celld deploy`. `vars` is an accepted config key ([cloudflare-compat.md](https://github.com/denoland/celld/blob/main/docs/cloudflare-compat.md)); `celld deploy` reads the config from disk ([docs/README.md](https://github.com/denoland/celld/blob/main/docs/README.md)). This keeps secrets out of the repository and out of application storage. Weaknesses: secrets land in the deployment manifest object inside the fleet bucket (`deploy/current.json` records the deployment; the bucket "contains the deployments" and its credentials are fleet root authority) ([security.md](https://github.com/denoland/celld/blob/main/docs/security.md), [docs/README.md](https://github.com/denoland/celld/blob/main/docs/README.md)); rotation requires a redeploy.
2. **Runtime secret object via R2 binding.** Store an encrypted/plain JSON secret blob under `r2/<bucket_name>/…` and read it in the Worker with the binding; write it with `celld r2 put` from the operator side ([R2 docs](https://github.com/denoland/celld/blob/main/docs/services/r2.md), [celld README](https://github.com/denoland/celld/blob/main/docs/README.md)). Anyone with bucket credentials can read it, but such a person already controls the fleet ([security.md](https://github.com/denoland/celld/blob/main/docs/security.md)). Useful for third-party credentials the app rotates at runtime (email API keys), not as a replacement for deploy-time `BETTER_AUTH_SECRET`.
3. **Wait for `celld secret put` (#190).** Open, unassigned, +1s only; do not block v2 on it ([issue #190](https://github.com/denoland/celld/issues/190)).
4. **`.dev.vars` for local dev only.** `celld dev` reads it; production does not ([docs/README.md](https://github.com/denoland/celld/blob/main/docs/README.md)).

**Consequence for OAuth/social login and email integration:** GitHub/Google client secrets and any email-provider key go through the same channel. If v2 starts invite-only with email/password, the only hard secret is `BETTER_AUTH_SECRET` (plus the D1 migration path), which makes option 1 sufficient.

---

## 8. Prior art

- **Vinnodrive v1 (in-repo):** Better Auth on Postgres with `BETTER_AUTH_SECRET`, email/password, and R2 storage ([README](../../README.md)). This is the strongest prior art: same library, different runtime. The migration cost is the storage adapter and crypto overrides, not the auth model.
- **NuxtHub × Better Auth (`atinux/nuxthub-better-auth`):** a maintained template deploying Better Auth to **Cloudflare Workers with D1** (or Vercel/Turso), using Wrangler `secret put` for the auth secret and D1 migrations via `wrangler d1 migrations apply`, with server-side session checks ([repo](https://github.com/atinux/nuxthub-better-auth)). It demonstrates the exact D1-shaped architecture minus celld's constraints.
- **`onmax/nuxt-better-auth`:** a Nuxt integration that carries a patch for `@peculiar/x509` to make the SimpleWebAuthn/passkey chain work on workerd, directly relevant to §3.6 ([repo](https://github.com/onmax/nuxt-better-auth), [patch](https://github.com/onmax/nuxt-better-auth/blob/main/patches/@peculiar__x509@1.14.2.patch), [x509 issue #116](https://github.com/PeculiarVentures/x509/issues/116)).
- **OpenAuth (formerly SST, now `anomalyco`):** self-hosted, Workers-deployable, OAuth-2.0-based auth server with a Cloudflare KV storage implementation; the alternate prior-art shape if in-process auth is rejected ([repo](https://github.com/anomalyco/openauth)).
- **Cloudflare's own node:crypto documentation** is the reference celld's compat page follows, and it confirms scrypt/pbkdf2 support and Argon2 exclusion on Cloudflare itself ([Cloudflare node:crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)) — useful because code that targets "Workers" will assume scrypt exists, which is exactly where celld diverges.

---

## 9. Recommendation

**Adopt Better Auth 1.7.x on celld, with explicit overrides, in this shape:**

1. **Pin an exact Better Auth version and commit the lockfile.** 1.7.7 was examined; Workers/D1 support is recent and moving. Re-run the celld smoke suite on every dependency bump.
2. **Database: one dedicated D1 database for auth**, wired as `database: env.DB`. Auth is a single-writer cell; keep it separate from product D1 databases to avoid write contention. Run migrations by generating SQL in CI against a local SQLite database and applying with `celld d1 migrations apply`, or via a one-shot protected `getMigrations()` endpoint ([database docs](https://www.better-auth.com/docs/concepts/database), [D1 docs](https://github.com/denoland/celld/blob/main/docs/services/d1.md)). Do not enable adapter `transaction: true`.
3. **Passwords: override `emailAndPassword.password.hash/verify` with PBKDF2-HMAC-SHA-256, 600k iterations**, 16-byte salt, 32-byte output, PHC-style storage, constant-time verify. Never let the default scrypt path execute. Consider Argon2id via WASM after v2.0 ships.
4. **Sessions: D1 sessions + `cookieCache: { strategy: "compact", maxAge: 60 }`** (or disabled initially if immediate revocation matters more than latency). Implement the `secondaryStorage` interface over a Durable Object only when session traffic demonstrably pressures the auth D1 cell.
5. **CSRF/transport: explicit https `baseURL`, exact `trustedOrigins`, `Secure` cookies, `ipAddressHeaders` set to the ingress-set header, no `trustedProxyHeaders` unless the proxy overwrites them.** Rely on Better Auth's built-in origin + Fetch Metadata protections.
6. **Onboarding: invite-only.** Owner creates the invitation; the app shows the invite link for out-of-band delivery; accept flow requires the invited email. No self-serve email verification/password reset until an email provider is integrated over outbound `fetch`.
7. **API surface: `@better-auth/api-key` with separate user and app-password configurations** (distinct prefixes, permissions, expiry, rate limits). Keep `enableSessionForAPIKeys` off unless a concrete need appears; verify keys explicitly in the API layer.
8. **Rate limits: `rateLimit.storage: "database"`** (or secondary storage) so limits are fleet-wide, not per-isolate.
9. **Secrets: deploy-time injection into a generated `wrangler.json`** from the operator's secret manager; document rotation via `BETTER_AUTH_SECRETS`. Use an R2 secret object only for runtime-rotated third-party credentials.
10. **Passkeys: phase 2.** Smoke-test the SimpleWebAuthn → x509 → tsyringe chain under `celld dev` before committing; keep password + TOTP (Better Auth 2FA plugin) as the baseline.
11. **CI: run a celld integration suite** — signup, login, `getSession`, revoke, API-key create/verify, D1 migration apply, D1 batch behavior, and a forced 503/overload path — against `celld dev`. This is the only way to catch workerd/Node-compat divergence, because celld is a different implementation from Cloudflare's workerd.

**Fallback if Better Auth proves too unstable on celld:** build the Auth Book session core in-house (random 256-bit tokens, SHA-256 token hashes in D1, HttpOnly/SameSite=Lax/Secure cookies, PBKDF2 passwords, per-user DO for rate limits). More owned security code, but only primitives celld verifiably implements.

---

## 10. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Better Auth default scrypt throws on celld (`notImplemented`) | **Critical** | Custom PBKDF2 hash/verify; smoke test in celld CI; consider overridding `@better-auth/utils` resolution as belt-and-braces |
| No secret store; secrets end up in `wrangler.json`/deployment manifest (issue #190) | **High** | Generated config at deploy from a secret manager; treat bucket credentials as operator-grade; rotate with `BETTER_AUTH_SECRETS` |
| Better Auth's Workers/D1 support is young (D1 support merged 2026-02-28; past regressions on Workers bundling) | **High** | Pin exact versions; celld integration tests in CI; watch releases/issues |
| celld is beta and "not safe for hostile multi-tenant use" | **High** | Keep signup invite-only; single-team fleets; TLS + proxy hardening; no hostile tenants |
| No email: invite/reset/verification flows cannot be standard | **Medium** | Link-based invites and admin-delivered reset links; optionally integrate an email API later |
| D1 single writer on the auth cell | **Medium** | One dedicated DB; short cookie cache; DO-based secondary storage later |
| Passkey dependency chain (`@peculiar/x509` → `tsyringe`/`reflect-metadata`) fails in direct workerd | **Medium** | Keep passkeys phase 2; smoke test; patch/vendor if needed |
| Better Auth CLI cannot reach celld D1 | **Medium** | Generate SQL in CI or run programmatic migrations; apply with `celld d1` |
| `rateLimit.storage` default `"memory"` is per-isolate | **Medium** | Set `"database"` or `"secondary-storage"` |
| celld `node:crypto` lacks ciphers/`createSign`/`createVerify`; libraries may assume them | **Medium** | Prefer Web Crypto paths; `@noble/*` pure JS covers the rest; test dependencies |
| KV/DO/D1 dispatches add latency to every session read | **Low/Medium** | Cookie cache; monitor; shard later |
| celld deploys code in place; schema/code version skew during rollout | **Medium** | Deploy order: apply D1 migration first, then code; keep migrations additive; rollout during low traffic |
| Better Auth 1.7.x breaking changes (e.g. `account` identity changes) | **Medium** | Follow upgrade guides; pin; test in celld dev before deploy |

---

## 11. Open questions (need hands-on verification or a product decision)

1. **Does celld's esbuild resolve the `workerd`/`node` export condition for `@better-auth/utils`?** This decides whether the default path throws (node scrypt) or silently runs the slow JS fallback. The plan should not depend on the answer.
2. **Does Better Auth's D1 auto-detection fire on celld's `env.DB` binding?** celld implements `prepare`, `bind`, `all`, `batch`, `exec` ([D1 docs](https://github.com/denoland/celld/blob/main/docs/services/d1.md)), which matches the detection contract ([dialect source](https://github.com/better-auth/better-auth/blob/main/packages/kysely-adapter/src/d1-sqlite-dialect.ts)); verify end to end.
3. **What is the migration workflow we accept?** `getMigrations()` endpoint vs. checked-in SQL generated against local SQLite vs. hand-maintained schema.
4. **Do we ever need runtime-managed secrets (email provider, social login) before #190 lands?** If yes, commit to the R2 secret-object pattern and its rotation story.
5. **Session store ceiling:** at what request rate does the D1 auth cell need to be replaced by DO-backed secondary storage? Instrument dispatch latency and cell concurrency (celld's 64-concurrent-request cap per DO, [celld README](https://github.com/denoland/celld)).
6. **Passkeys in scope for v2 launch?** The x509/tsyringe chain needs a `celld dev` smoke test either way.
7. **TOTP/2FA?** Better Auth has a 2FA plugin; it needs an encryption secret (`BETTER_AUTH_SECRET`) and works without email. Not researched in depth here.
8. **Backup/restore of the auth D1 database.** celld D1 state lives in the bucket and is replicated; verify a restore drill (D1 has no Time Travel; `celld d1` is the only console) ([D1 docs](https://github.com/denoland/celld/blob/main/docs/services/d1.md)).
9. **Invite link leakage policy:** single-use tokens with a hard expiry, inviter-only visibility, and rate-limited acceptance endpoints.
10. **Should the API surface use the api-key plugin's permission model or a separate token table?** The plugin is the default; a custom table only if permissions outgrow it.

---

## 12. Source index

**celld**
- Repository and README: https://github.com/denoland/celld
- Docs index: https://github.com/denoland/celld/tree/main/docs
- Cloudflare compatibility: https://github.com/denoland/celld/blob/main/docs/cloudflare-compat.md
- Security model: https://github.com/denoland/celld/blob/main/docs/security.md
- Limitations: https://github.com/denoland/celld/blob/main/docs/limitations.md
- Workers service: https://github.com/denoland/celld/blob/main/docs/services/workers.md
- D1 service: https://github.com/denoland/celld/blob/main/docs/services/d1.md
- KV service: https://github.com/denoland/celld/blob/main/docs/services/kv.md
- Durable Objects: https://github.com/denoland/celld/blob/main/docs/services/durable-objects.md
- R2 service: https://github.com/denoland/celld/blob/main/docs/services/r2.md
- WebAssembly: https://github.com/denoland/celld/blob/main/docs/wasm.md
- Operator/deploy docs: https://github.com/denoland/celld/blob/main/docs/README.md
- `node:crypto` shim source: https://github.com/denoland/celld/blob/main/crates/celld/js/node_crypto.js
- Web Crypto shim source: https://github.com/denoland/celld/blob/main/crates/celld/js/crypto.js
- Workspace dependencies: https://github.com/denoland/celld/blob/main/Cargo.toml
- Issue #190 (secret support, open): https://github.com/denoland/celld/issues/190
- Issue #219 (`CELLD_VAR_*` removal): https://github.com/denoland/celld/issues/219
- celld.dev: https://celld.dev

**Better Auth**
- Installation (Workers tab): https://www.better-auth.com/docs/installation
- Database and secondary storage: https://www.better-auth.com/docs/concepts/database
- Session management: https://www.better-auth.com/docs/concepts/session-management
- Security reference (scrypt default, CSRF): https://www.better-auth.com/docs/reference/security
- Options reference (secret, password override, rate limit, advanced): https://www.better-auth.com/docs/reference/options
- API key plugin: https://www.better-auth.com/docs/plugins/api-key
- API key advanced: https://www.better-auth.com/docs/plugins/api-key/advanced
- API key reference: https://www.better-auth.com/docs/plugins/api-key/reference
- Passkey plugin: https://www.better-auth.com/docs/plugins/passkey
- Organization plugin (invitations): https://www.better-auth.com/docs/plugins/organization
- PR #7519 (built-in D1 support): https://github.com/better-auth/better-auth/pull/7519
- D1 dialect source: https://github.com/better-auth/better-auth/blob/main/packages/kysely-adapter/src/d1-sqlite-dialect.ts
- Kysely adapter (transaction default): https://github.com/better-auth/better-auth/blob/main/packages/kysely-adapter/src/kysely-adapter.ts
- API key hasher source: https://github.com/better-auth/better-auth/blob/fd6b8c13/packages/api-key/src/index.ts
- Workers bundling issues: https://github.com/better-auth/better-auth/issues/4404 and https://github.com/better-auth/better-auth/issues/9649
- D1 setup discussion: https://github.com/better-auth/better-auth/discussions/7487
- npm package metadata: https://unpkg.com/better-auth/package.json
- `@better-auth/utils` 0.4.2: https://unpkg.com/@better-auth/utils@0.4.2/package.json , https://unpkg.com/@better-auth/utils@0.4.2/dist/password.node.mjs
- `@better-auth/passkey` 1.7.7: https://unpkg.com/@better-auth/passkey/package.json

**Other libraries and prior art**
- Lucia (deprecated): https://lucia-auth.com/ ; Auth Book: https://auth.pilcrowonpaper.com
- oslo (archived): https://github.com/pilcrowonpaper/oslo ; OsloJS: https://oslojs.dev
- Arctic (deprecated): https://github.com/pilcrowonpaper/arctic
- OpenAuth: https://github.com/anomalyco/openauth
- SimpleWebAuthn server docs: https://simplewebauthn.dev/docs/packages/server ; JSR: https://jsr.io/@simplewebauthn/server
- `@peculiar/x509` edge issue: https://github.com/PeculiarVentures/x509/issues/116
- NuxtHub Better Auth (D1 example): https://github.com/atinux/nuxthub-better-auth
- onmax/nuxt-better-auth x509 patch: https://github.com/onmax/nuxt-better-auth/blob/main/patches/@peculiar__x509@1.14.2.patch

**Platform/docs**
- Cloudflare node:crypto: https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/
- Cloudflare Web Crypto: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- OWASP Password Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
