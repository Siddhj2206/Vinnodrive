# Research: file preview and thumbnail options on celld/workerd

- Wayfinder ticket **#5** ("Research: file preview and thumbnail options on celld/workerd"), map issue **#1** (Vinnodrive v2).
- Date: 2026-10-04. celld docs read at **v0.6.1** (beta).
- Method: primary sources only (official docs, repos, READMEs, issues, release data). **No runtime testing was done.** Claims are marked:
  - **[verified]** — stated by a primary source linked inline,
  - **[inference]** — my reasoning from verified facts,
  - **[untested]** — plausible but not confirmed on celld; needs a spike.

**One precision up front:** celld is not literally workerd. It is Deno Land's V8 + SQLite + LTX runtime that executes Wrangler bundles and implements the Workers API ([celld.dev](https://celld.dev/), [celld docs](https://celld.dev/docs)). Cloudflare/workerd docs are therefore strong evidence, not proof; celld's own compatibility page is the contract. No claim below relies on a workerd behavior that celld doesn't document or that a celld-targeted library doesn't exercise.

---

## 1. Runtime constraints that shape every option

These are the facts the rest of the document reasons from.

1. **celld services available:** Workers, Durable Objects, KV, Queues, D1, R2, Workflows, Cron Triggers, static assets are supported; **Containers are experimental**; Workers AI, Vectorize, Hyperdrive, Browser Rendering and Email Workers are **not** available ([celld.dev](https://celld.dev/), [Cloudflare compatibility](https://celld.dev/docs/cloudflare-compat)). The AI binding is actively rejected at deploy/startup ([celld Workers docs](https://celld.dev/docs/services/workers)).
2. **No Workers AI.** Any image understanding/ML (smart crop, OCR) is out; only deterministic codecs matter. Workers AI is listed as `No` ([compat table](https://celld.dev/docs/cloudflare-compat)).
3. **WASM is first-class, but must be imported at deploy time.** A Worker bundle imports `.wasm` and receives a **compiled module**, not bytes; `celld deploy` uses esbuild, applies a built-in `CompiledWasm` rule to `**/*.wasm`, uploads the file beside the bundle, and **compiles each module once per process** for reuse across isolates ([celld WebAssembly](https://celld.dev/docs/wasm)). This means codecs are deployment artifacts; you cannot fetch `.wasm` bytes from R2 at runtime. Wasm bytes count against deployment size limits like JS ([celld WebAssembly §Limits](https://celld.dev/docs/wasm)).
4. **No threads, no Web Workers (upstream runtime).** Cloudflare documents: "Threading is not possible in Workers. Each Worker runs in a single thread, and the Web Worker API is not supported." SIMD is supported ([Workers WebAssembly](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)). `WebAssembly.instantiate()` only supports pre-compiled modules ([Wasm in JavaScript](https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript)). celld's compat page lists no Web Worker API and its wasm page matches Wrangler's import rule ([celld compat](https://celld.dev/docs/cloudflare-compat), [celld WebAssembly](https://celld.dev/docs/wasm)). Treat "no threads / no nested workers" as a hard celld constraint: **[verified for Cloudflare; untested for celld]**.
5. **Memory: 128 MB V8 heap per isolate by default** — "Each isolate also has a V8 heap limit ... The default is 128 MB ... set `CELLD_V8_HEAP_LIMIT_MB`" ([celld README](https://github.com/denoland/celld/blob/main/README.md)). At 90% heap a new hibernatable WebSocket is refused; at 100% SQL result materialization stops; the isolate resumes below 75% ([celld README](https://github.com/denoland/celld/blob/main/README.md)). Cloudflare's equivalent limit explicitly includes "the JavaScript heap and WebAssembly allocations" ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)); **whether celld's V8 heap limit counts WASM linear memory is not stated — open question.**
6. **Cache API is a stub on celld.** `put()` stores nothing, `match()` returns `undefined`, `delete()` returns `false`; "celld provides an always-miss cache because it has no shared edge cache" ([celld compat §Cache](https://celld.dev/docs/cloudflare-compat)). All caching of derivatives must live in R2/KV (or the browser).
7. **R2 is the fleet bucket behind a binding, with no public URL.** There is "no public bucket URL, no presigned URL, and no S3 endpoint into an R2 binding, so an application must put a Worker in front of the bytes it wants to publish" ([celld R2](https://celld.dev/docs/services/r2)). Objects support `httpMetadata`, `customMetadata`, ETags, ranges, conditional operations via `onlyIf`, and multipart uploads above 8 MiB; `get()` returns a `ReadableStream` "so a large object never has to fit in the isolate heap" ([celld R2](https://celld.dev/docs/services/r2)).
8. **Queues exist and are the intended async pattern.** celld's own example use case is "an email, a webhook call, **a thumbnail**, or a search index update" ([celld Queues](https://celld.dev/docs/services/queues)). Message ≤128,000 bytes, batch ≤100 messages/256,000 bytes, at-least-once delivery, `message.id` stable across redelivery, 4-day retention, dead-letter queues, no R2 event notifications ([celld Queues](https://celld.dev/docs/services/queues)). **No R2 event notifications** means the upload handler must enqueue explicitly.
9. **Workflows exist but are heavier than needed.** Instance-per-cell, durable steps, default 5 retries with exponential backoff, 10-min attempt timeout, 1 MiB step-result limit, no `schedules` key ([celld Workflows](https://celld.dev/docs/services/workflows)).
10. **Node compat is partial.** `node:fs` is read-only-ish (`/bundle` read-only, empty request-local `/tmp`), `node:zlib` is sync-only, no ciphers/streaming signatures in `node:crypto` ([celld compat §Node.js](https://celld.dev/docs/cloudflare-compat)). Native addons (sharp, node-canvas) cannot work.

---

## 2. In-Worker image decoding (WASM codecs)

### 2.1 What actually runs on Workers-style runtimes

| Library | Runtime support | Evidence | License / size | v1 fit |
|---|---|---|---|---|
| **jSquash** (`@jsquash/jpeg`, `png`, `webp`, `resize`, `avif`, `jxl`, `qoi`, `oxipng`) | Browser/Web Worker first, **explicitly safe for Cloudflare Workers**: "No dynamic code execution, the packages can be run in strict environments that do not allow code evaluation. Like Cloudflare Workers." Ships an official Cloudflare Worker ESM example | [repo README](https://github.com/jamsinclair/jSquash), [CF Worker example](https://github.com/jamsinclair/jSquash/tree/main/examples/cloudflare-worker-esm-format) | Apache-2.0; `@jsquash/jpeg` unpacked 530 KB, `@jsquash/resize` 252 KB ([registry](https://registry.npmjs.org/@jsquash/jpeg/latest)) | **Primary choice** |
| **@cf-wasm/photon** (Rust Photon) | Built for Workers: conditional export `@cf-wasm/photon/workerd`; README warns "Cloudflare Workers have strict memory caps (typically 128 MB) ... validate input image size or reject oversized images before processing" | [package README](https://github.com/fineshopdesign/cf-wasm/blob/main/packages/photon/README.md) | Apache-2.0, package ~6 MB | **Backup / cross-check** |
| **wasm-vips** | **Cannot run.** Requires threads + SharedArrayBuffer; maintainer: "wasm-vips in its current form can never run on Cloudflare workers"; closed won't-fix 2023-05 | [issue #2](https://github.com/kleisauke/wasm-vips/issues/2), [cf-worker-wasm-vips](https://github.com/kleisauke/cf-worker-wasm-vips) | LGPL-2.1+ (libvips) | No |
| **magick-wasm** (ImageMagick) | Documented for browser/Node/Deno, not Workers | [repo](https://github.com/dlemstra/magick-wasm) | Apache-2.0, large | [untested] later |
| **resvg / satori via `cf-wasm`** | `cf-wasm` collection targets Workers | [repo](https://github.com/fineshopdesign/cf-wasm) | varies | Optional for SVG/OG images |

Notes from the jSquash Cloudflare example that matter for celld: the example imports each codec's WASM file explicitly and calls the package `init(wasmModule)` because "Cloudflare Workers do not support dynamic imports"; it decodes JPEG/PNG and encodes WebP; and it caches results with `caches.default` ([example `src/index.js`](https://github.com/jamsinclair/jSquash/blob/main/examples/cloudflare-worker-esm-format/src/index.js)). On celld the import/init half maps cleanly onto `celld`'s compiled-module imports, but **every `caches.default` use must be replaced with R2**, since celld's Cache API always misses. Also, jSquash publishes single-thread-only special builds for `avif`, `jxl` and `oxipng` because nested Web Workers break some bundlers ([README known issues](https://github.com/jamsinclair/jSquash)); given constraint #4, **exclude AVIF/JXL/oxipng from v1** or use the `-single-thread-only` builds. JPEG/PNG/WebP decode and `resize` are the safe, exercised set.

### 2.2 Decode memory math — where 128 MB actually bites

- Raw RGBA pixels are 4 bytes/pixel; a 100×100 image produces a 40,000-value `Uint8ClampedArray` ([MDN ImageData.data](https://developer.mozilla.org/en-US/docs/Web/API/ImageData/data), spec link on page). **[verified]**
- Therefore: 4000×3000 (12 MP) = **48 MB** RGBA; 6000×4000 (24 MP) = **96 MB**; 8000×6000 (48 MP) = **192 MB**. Decoding typically has the compressed input, the codec's WASM heap, the decoded buffer, a resized copy, and the encoded output alive at once, so realistic headroom is roughly **half** the raw-buffer number. **[inference]**
- Practical guidance for v1: hard-gate input bytes (e.g. ≤10–15 MB) **and** decoded dimensions (e.g. ≤16 MP) before/at decode; mark anything larger "no thumbnail" and fall back to the type icon. `@cf-wasm/photon` publishes the same warning independently. **[inference from [verified] facts]**
- Cloudflare's own image product is a useful upper-bound reference: it offers format negotiation, AVIF/WebP/JPEG transcoding and notes "AVIF encoding can be an order of magnitude slower than encoding to other formats" ([Images features](https://developers.cloudflare.com/images/optimization/features/)). Max-quality/format handling is the expensive part; a modest WebP thumbnail is the cheap part.

### 2.3 Where decode cost bites on celld

1. **Input buffering:** R2 `get()` streams, but a decoder needs the full compressed bytes, so `await (await r2.get(key)).arrayBuffer()` puts the file in the isolate. Size-gate first. ([celld R2](https://celld.dev/docs/services/r2))
2. **Peak decode memory** (above), magnified because the isolate limit is 128 MB by default.
3. **WASM compile:** celld compiles each module once per process, so cold-start compile is amortized across isolates and requests — a real advantage over vanilla Node ([celld WebAssembly](https://celld.dev/docs/wasm)). **[verified]**
4. **CPU:** Cloudflare's default HTTP CPU budget is 30 s (max 5 min, paid) ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)); celld documents no CPU cap, but a queue consumer runs in an isolate, so a decode that takes seconds is acceptable asynchronously and should not happen in the upload request path. **[inference]**
5. **Isolate reuse:** celld runs many requests in one isolate and retires it later ([celld Workers](https://celld.dev/docs/services/workers)). WASM linear memory growth may persist per isolate; repeated large decodes in one isolate are a heap risk. **[untested — needs measurement.]**

---

## 3. Video

### 3.1 Server-side frame extraction on workerd/celld: effectively no

- ffmpeg.wasm is now **browser-only**: "ffmpeg.wasm did support nodejs before 0.12.0, but decided to discontinue nodejs support", recommending native ffmpeg instead ([FAQ](https://ffmpegwasm.netlify.app/docs/faq)).
- Its architecture offloads to a Web Worker (`ffmpeg.worker`), and the multi-thread core spawns more web workers ([Overview](https://ffmpegwasm.netlify.app/docs/overview)). Native workerd has no Web Worker API and no threading ([Workers WebAssembly](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)). Even the single-threaded core is documented as slow, and multi-threading "consume[s] a lot more memory and cpu" ([FAQ](https://ffmpegwasm.netlify.app/docs/faq)). The WASM FS has a 2 GB hard limit ([FAQ](https://ffmpegwasm.netlify.app/docs/faq)).
- Conclusion: no viable in-Worker ffmpeg for celld v1. **[verified]** A hand-rolled MP4 demux + WebCodecs decode is also impossible server-side because workerd exposes no WebCodecs. **[inference]**

### 3.2 celld Containers (experimental) — the only true server-side route

celld Containers run a Docker/Podman container supervised by a SQLite-backed Durable Object on the node that owns the object; `@cloudflare/containers` works as published; instance types run from `dev` (1/16 CPU, 256 MiB) upward, with idle stop defaults matching Cloudflare (10 min); images are built/pulled by `celld deploy`, stored in the fleet bucket, and loaded by nodes; the container disk is ephemeral; the API surface (`start`, `getTcpPort`, `exec`, `sleepAfter`) is implemented while `inspect`/snapshots/outbound interception are not; the docs warn config keys, API and security boundary can change without notice ([celld Containers](https://celld.dev/docs/services/containers)). A sidecar (ffmpeg, imgproxy, thumbor) would give deterministic server-side video/PDF/image handling, but it raises ops cost materially: **every node that serves the class needs a Docker or Podman daemon**, the container shares the node kernel unless an alternate OCI runtime is named, and the feature is experimental. This is a **v2+ option**, not v1 infrastructure.

### 3.3 Client-side thumbnailing at upload — the proven alternative

- FlareDrive generates video thumbnails in the browser with `HTMLVideoElement` + `canvas` at upload (mp4 only, with a 2-second load timeout), draws a 144×144 frame, hashes it (SHA-1), uploads the PNG to R2 under `_$flaredrive$/thumbnails/<digest>.png`, then sets an `fd-thumbnail` header so the WebDAV PUT stores it as `customMetadata.thumbnail` ([transfer.ts](https://github.com/longern/FlareDrive/blob/main/src/app/transfer.ts), [put.ts](https://github.com/longern/FlareDrive/blob/main/functions/webdav/put.ts), [FileGrid.tsx](https://github.com/longern/FlareDrive/blob/main/src/FileGrid.tsx)).
- Davflare (a full rewrite of FlareDrive) keeps the same thumbnail convention and serves thumbs through an authenticated `authFetch` blob with an object-URL cache ([AuthThumbnail.tsx](https://raw.githubusercontent.com/fanchenggang/Davflare/main/src/AuthThumbnail.tsx)).
- WebCodecs `VideoDecoder` is the higher-fidelity alternative when available: Chrome 94+, Firefox 130+, Safari 16.4 partial → 26.0+ full; global support 94.47% ([caniuse](https://caniuse.com/webcodecs), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder)). MDN still marks it "limited availability", and codec support varies by OS/browser. Use `<video>`+canvas as the universal fallback. **[verified support data]**
- Preconditions/limits: only runs in the uploader's browser (so API/WebDAV/curl uploads get no poster), decode support for HEVC/AV1 varies, and long videos need a seek to a representative frame; FlareDrive's 2-s timeout shows the failure mode. Application code — not a runtime gap. **[verified for FlareDrive code; inference for the rest]**
- Current Vinnodrive v1 already renders `<video preload="metadata">` for video thumbnails and an `<iframe>` for PDFs ([file-thumbnail.tsx](../apps/web/src/components/dashboard/file-thumbnail.tsx), [file-preview-modal.tsx](../apps/web/src/components/dashboard/file-preview-modal.tsx)) — i.e. it streams the original; there is no stored poster today.

### 3.4 Metadata-only extraction

- `mp4box.js` parses MP4/MOV boxes progressively from `ArrayBuffer`s and reports duration, track dimensions, codec and more via `onReady`; it works in browser and Node ([README](https://github.com/gpac/mp4box.js)). Pure JS, no decode, so it can run in a Worker. Caveat: files whose `moov` atom is at the end (non-faststart) require reading to the tail — the library's `appendBuffer`/`fileStart` design supports that, but the Worker may need range reads or a full GET depending on layout ([README](https://github.com/gpac/mp4box.js)).
- `mediabunny` is a pure-TypeScript, zero-dependency demux/mux toolkit covering MP4/WebM/MKV and more, with a server package for Node/Bun/Deno; decode paths use WebCodecs, metadata reading does not have to ([README](https://github.com/Vanilagy/mediabunny), MPL-2.0). **Workerd support is unverified.**
- v1 verdict: capture `duration`, `videoWidth`, `videoHeight` in the browser from the same `<video>` element used for the poster. Server-side MP4 metadata is optional polish, and WebM/MKV server-side parsing is out of scope.

---

## 4. PDF

### 4.1 Client-side PDF.js — proven and cheap

- PDF.js is a web-standards PDF viewer; rendering a page is `page.render({ canvasContext, viewport })` on an HTML canvas ([hello-world example](https://github.com/mozilla/pdf.js/blob/master/examples/learning/helloworld.html)).
- FlareDrive does exactly this for thumbnails at upload: imports PDF.js 4.4.168 from a CDN, loads the file as an object URL, renders page 1 scaled into the 144×144 canvas, and uploads the PNG ([transfer.ts](https://github.com/longern/FlareDrive/blob/main/src/app/transfer.ts)). Vinnodrive would bundle `pdfjs-dist` instead of a CDN import.
- For **preview**, a client-side PDF.js viewer (or the existing `<iframe>`/browser viewer, which is what v1 does today) avoids all server work. If a Worker proxies the original with Range support, pdf.js can fetch ranges instead of the whole file; celld R2 supports ranges ([celld R2](https://celld.dev/docs/services/r2)). **[inference]**
- Failure modes: password-protected/corrupt PDFs; very large documents on low-memory devices. Fall back to the PDF icon.

### 4.2 Server-side PDF rasterization — all options are expensive

- **PDF.js in Node requires a canvas implementation.** Mozilla's own `pdf2png` Node example uses `pdfDocument.canvasFactory` and `canvas.toBuffer("image/png")` ([example](https://github.com/mozilla/pdf.js/blob/master/examples/node/pdf2png/pdf2png.mjs)). Node canvases are native (`@napi-rs/canvas`, node-canvas) and cannot load on celld; workerd exposes no `CanvasRenderingContext2D`. So PDF.js cannot rasterize server-side without a WASM canvas shim. **[verified example + verified runtime absence]**
- **MuPDF.js** is the strongest server-side candidate: official Artifex library, WASM (no native deps), renders pages directly to `Pixmap.asPNG()`/`asJPEG()` — no canvas needed — and supports Node, Bun, Deno and browsers ([README](https://github.com/ArtifexSoftware/mupdf.js)). But it is **AGPL-3.0 or commercial**: "If you distribute software that uses mupdf.js, or provide it as a network service, you must release your source code under the AGPL" ([README](https://github.com/ArtifexSoftware/mupdf.js)). Workerd/celld support is **[untested]**.
- **PDFium WASM:** `@embedpdf/pdfium` is MIT + Apache-2.0 PDFium WASM, browser-focused, ~10.7 MB unpacked, latest 2.14.x ([npm](https://www.npmjs.com/package/@embedpdf/pdfium)); `urish/pdfium-wasm` is Node-only and stale since 2018 ([README](https://github.com/urish/pdfium-wasm/blob/master/README.md)). Server-side/workerd use is **[untested]**.
- **pdf-lib cannot rasterize** — it creates and modifies PDFs (metadata, forms, embedding) and has no render API ([README](https://github.com/Hopding/pdf-lib)). It could read metadata/title/page count in a Worker if needed. **[verified scope]**
- v1 verdict: client-side page-1 thumbnail via PDF.js; server-side raster deferred to a spike (MuPDF candidate, license decision required; container ffmpeg/mupdf sidecar as another v2 route).

---

## 5. Orchestration, caching and idempotency

### 5.1 Job flow

- **Enqueue in the upload handler** — R2 event notifications do not exist on celld ([celld Queues](https://celld.dev/docs/services/queues)), so after the original is committed to R2, the Worker calls `env.PREVIEWS.send({ fileId, etag, contentType, size })`. The message stays small (≤128 KB) and carries no bytes. `send()` resolves after the queue cell durably commits ([celld Queues](https://celld.dev/docs/services/queues)). **[verified]**
- **Consume in a queue handler** — batch consumer, per-message `ack()`/`retry({delaySeconds})`, dead-letter queue; delivery is at-least-once and `message.id` is stable, so handlers must be idempotent ([celld Queues](https://celld.dev/docs/services/queues)). Do not use Workflows for the v1 thumbnail: it buys durable multi-step orchestration we don't need and adds per-instance cells; it becomes attractive only if previews become multi-stage (e.g. container transcode + variants) ([celld Workflows](https://celld.dev/docs/services/workflows)). **[inference]**
- **Fallback generation on first request** — because queues retain messages only 4 days and a backlog can be lost, the `GET /files/:id/thumb` handler should check for the derived object and enqueue a job (once) when missing, returning the icon/placeholder meanwhile. **[inference]**

### 5.2 Where derivatives live

- **Store derivatives in R2**, e.g. `thumbs/<fileId>/<contentEtag>/256.webp` plus `previews/<fileId>/<contentEtag>/1280.webp`. Include the source object's version/etag in the key so re-uploading a file never serves a stale preview; celld's object `version` equals the content ETag (identical bytes → same version) ([celld R2](https://celld.dev/docs/services/r2)). **[verified + design inference]**
- **Do not use the Cache API.** It always misses on celld ([celld compat](https://celld.dev/docs/cloudflare-compat)). R2 is the cache; browser caching handles repeat views.
- **Skip repeated work with `head()` + deterministic keys.** The consumer checks `head(thumbKey)` first and exits if present; races are harmless because writes are idempotent for identical bytes. R2 conditional ops (`onlyIf` with `If-None-Match`) can make "generate once" explicit, but note conditional writes cannot use streamed bodies >8 MiB ([celld R2](https://celld.dev/docs/services/r2)). **[verified semantics + design inference]**
- **Status tracking:** a per-file row in the owning Durable Object's SQLite (status: `none|pending|ready|failed`, attempts, thumb key) is cheap and lets the UI render an icon without probing R2 on every list render. R2 existence remains the source of truth for bytes. **[inference]**

### 5.3 Serving bytes

- celld R2 has no public/presigned URLs ([celld R2](https://celld.dev/docs/services/r2)), so a Worker route fronts both originals and derivatives: stream `R2ObjectBody.body` through without buffering (safe for large video/PDF, per celld R2 docs), pass through Range (§ R2 supports `offset`/`length`/`suffix`/`Range`), set `ETag` from `object.httpEtag` and return `304` on `If-None-Match`, and set long-lived `Cache-Control` (`immutable` for etag-keyed derivatives). **[verified capabilities + design inference]**
- Understood trade-off: celld has no CDN ("`passThroughOnException()` has no effect because celld has no CDN fallback", [celld Workers](https://celld.dev/docs/services/workers)), so every request hits a Worker; client-side caching and R2 streaming are the mitigations. **[verified]**

---

## 6. Prior art

| Project | Stack | Preview/thumbnail approach | Source |
|---|---|---|---|
| **Cloudflare Images / Transformations** | Cloudflare platform | `cf.image` fetch options or Images binding: resize/crop/format negotiation (AVIF/WebP/JPEG), gravity/DPI; originals cached by Cloudflare. **Not available on celld** (no CDN; the compat bindings table doesn't include Images and each unlisted binding type is unavailable) | [Images features](https://developers.cloudflare.com/images/optimization/features/), [celld compat](https://celld.dev/docs/cloudflare-compat) |
| **jSquash Cloudflare Worker example** | Workers | Decode JPEG/PNG in-Worker, encode WebP, manual WASM `init()`, `caches.default` caching | [example](https://github.com/jamsinclair/jSquash/tree/main/examples/cloudflare-worker-esm-format) |
| **FlareDrive** (`longern/FlareDrive`, 551★, MIT) | Pages + R2, WebDAV | **Client-side** upload-time generation: image via canvas, `video/mp4` via `<video>`+canvas (2 s timeout), PDF via PDF.js CDN; 144 px PNG, SHA-1 digest, stored at `_$flaredrive$/thumbnails/<digest>.png`, digest in `customMetadata.thumbnail`; grid loads thumbs over WebDAV | [README](https://github.com/longern/FlareDrive), [transfer.ts](https://github.com/longern/FlareDrive/blob/main/src/app/transfer.ts), [put.ts](https://github.com/longern/FlareDrive/blob/main/functions/webdav/put.ts) |
| **Davflare** (`fanchenggang/Davflare`, MIT; rewrite of FlareDrive) | Pages + R2, WebDAV, MCP | Same stored-thumbnail convention; auth-aware blob loader with object-URL cache; server-side thumbnail GC test exists | [README](https://github.com/fanchenggang/Davflare), [AuthThumbnail.tsx](https://raw.githubusercontent.com/fanchenggang/Davflare/main/src/AuthThumbnail.tsx) |
| **sagan/FlareDrive** | Workers + R2 + KV + D1 | Fork with the same feature set (image/video/PDF thumbnails, previews) | [repo](https://github.com/sagan/FlareDrive) |
| **r2-webdav** (`abersheeran/r2-webdav`, 346★) | Workers + R2 | WebDAV only, no thumbnails | [README](https://github.com/abersheeran/r2-webdav) |
| **@cf-wasm/photon** | workerd/edge/Node | WASM decode/resize/encode with an explicit workerd entrypoint and 128 MB warning | [README](https://github.com/fineshopdesign/cf-wasm/blob/main/packages/photon/README.md) |

The pattern across the self-hosted R2 drives is unambiguous: **all of them generate previews on the client at upload and store the result in R2**; none run server-side media processing. Cloudflare's server-side quality offering is a platform product celld doesn't have.

---

## 7. Recommended v1 approach

**Split by format: server-side for images, client-side for video and PDF, all derivatives in R2.**

1. **Upload path.** Worker streams the original into R2 (multipart >8 MiB per celld docs), writes the file record, and enqueues a `preview` queue message `{ fileId, etag, contentType, sizeBytes }` (durable on `send()`; no R2 events exist).
2. **Client best-effort pass.** While the same upload UI still has the `File`:
   - **Video:** seek a poster frame with `<video>`+canvas (WebCodecs when `VideoDecoder.isConfigSupported` says yes), and capture duration/dimensions from the element. Upload the poster blob to a presigned-free Worker endpoint that stores it as the derived R2 object.
   - **PDF:** render page 1 with bundled `pdfjs-dist` to a canvas, upload the PNG the same way.
   - Failure is non-fatal: the file record stays `pending` for the server path / icon fallback.
3. **Server-side images (queue consumer).** For `image/jpeg`, `image/png`, `image/webp` (v1 allowlist): `head()` the target key; if absent, gate on file size (e.g. ≤10–15 MB) and decode via **jSquash** (`@jsquash/jpeg|png|webp` decode → `@jsquash/resize` → `@jsquash/webp` encode, using the manual `init(wasmModule)` pattern from the official Cloudflare example; `@cf-wasm/photon` is the fallback library if a codec misbehaves). Produce a ~256 px WebP thumbnail and optionally a ~1280 px preview; write both to R2 under etag-qualified keys; update the status row. Anything over the size/pixel gate or an unsupported type is marked `failed` and shown as a type icon. Exclude AVIF/JXL/SVG/HEIC/GIF-animation from v1.
4. **Serving.** One Worker route per file: `/files/:id/raw` (streamed, Range-aware, ETag/304) and `/files/:id/thumb/:spec` (derived object or placeholder; ETag/304, long `Cache-Control`). Because celld R2 has no public/presigned URLs, all bytes go through the Worker; the body streams so large files never enter the isolate heap.
5. **Idempotency and recovery.** Queue delivery is at-least-once; the consumer is a pure function of `(fileId, etag, spec)` so redelivery just rewrites the same key. If a thumb request finds no object and no recent job, it re-enqueues once and returns the placeholder. The file record's status field drives UI icons.
6. **Explicit non-goals for v1:** server-side video frame extraction, server-side PDF rasterization, Containers. Add a container sidecar (ffmpeg/mupdf/imgproxy) only if deterministic server-side previews become a requirement — and treat it as a v2 decision because celld Containers are experimental.

Why this is the right cut: in-Worker image generation is the only server-side path with an exercised Workers precedent and a workerd-targeted library; video and PDF server-side fail on hard runtime properties (no threads, no Web Workers, no canvas, browser-only ffmpeg.wasm, AGPL MuPDF), while client-side generation is exactly what the two leading self-hosted R2 drives ship and gives instant thumbnails at zero server CPU.

---

## 8. Biggest risks

1. **Heap blowups on large images.** A 24 MP image is already ~96 MB RGBA ([arithmetic from ImageData spec](https://developer.mozilla.org/en-US/docs/Web/API/ImageData/data)); decode peak + WASM heap can cross 128 MB and abort the isolate/queue batch. Mitigation: byte + pixel gates, try/catch, icon fallback; verify whether `CELLD_V8_HEAP_LIMIT_MB` counts WASM memory.
2. **No true isolate-level memory isolation per job.** celld reuses isolates across requests; repeated large decodes may accumulate WASM linear memory until the isolate retires. Needs measurement ([untested]).
3. **jSquash nested-worker variants.** `avif`/`jxl`/`oxipng` default builds involve workers; on a no-Web-Workers runtime they may fail. Mitigation: stick to jpeg/png/webp/resize in v1.
4. **Client-generated previews are best-effort.** API/WebDAV/curl uploads and unsupported codecs get no poster; video capture depends on the uploader's browser and codec support (MDN: WebCodecs "limited availability"; FlareDrive uses a 2 s timeout for `<video>`).
5. **celld is beta (v0.6.1) and Containers are experimental.** API/config drift is expected; keep Containers off the critical path ([celld limitations](https://celld.dev/docs/limitations), [celld Containers](https://celld.dev/docs/services/containers)).
6. **No CDN / no Cache API.** Every thumb request costs a Worker invocation and an R2 read; heavy grid views hit the Worker every time ([celld compat §Cache](https://celld.dev/docs/cloudflare-compat)).
7. **License trap.** MuPDF.js server-side rendering is AGPL-or-commercial; decide before prototyping it ([mupdf.js README](https://github.com/ArtifexSoftware/mupdf.js)).
8. **Bundle growth.** Multiple codec WASMs add megabytes to the deployment and count like JS ([celld WebAssembly](https://celld.dev/docs/wasm)); celld's deployment size ceiling is undocumented in the pages read.

## 9. Open questions

1. Does `CELLD_V8_HEAP_LIMIT_MB` (default 128 MB) include WASM linear memory, as Cloudflare's 128 MB product limit does? What is the largest image that reliably thumbnails on a default celld node?
2. Does celld's V8 runtime have the Web Workers API at all? (Cloudflare's does not; celld's compat table doesn't list it.) This determines whether default jSquash `avif`/`jxl`/`oxipng` builds can ever work.
3. Does the jSquash `init(importedWasmModule)` pattern work unchanged under celld's esbuild + `CompiledWasm` pipeline, including multiple codecs in one Worker? (Expected yes; needs a celld dev spike.)
4. Does `@cf-wasm/photon`'s `/workerd` export work under celld's deploy pipeline? Which of jSquash vs photon gives the better quality/size for thumbnails?
5. Does celld impose a deployment/bundle size limit that constrains how many codecs we ship?
6. What is the memory behavior of consecutive decodes in one reused isolate on celld — does WASM memory shrink or does the isolate need retirement tuning?
7. Are MuPDF.js or `@embedpdf/pdfium` usable on celld for server-side PDF rasterization, and is the AGPL acceptable for the project's license model? (If not, server-side PDF is container-only.)
8. Should the preview/thumbnail Worker be on the same origin as the app? Serving user HTML/PDF from the app origin is an XSS/CSRF surface; Davflare deliberately serves user sites from a separate hostname ([Davflare README](https://github.com/fanchenggang/Davflare)). celld does not terminate TLS or manage domains ([celld Workers](https://celld.dev/docs/services/workers)).
9. For video: do we need poster frames for WebM/MKV/AV1/HEVC, and what fallback is acceptable when WebCodecs and `<video>` both fail? For PDF: how do we handle password-protected PDFs?
10. Do uploaded **audio** files need waveforms (out of scope here), and does that change the queue/store design?

---

## Sources

celld and Cloudflare runtime:
- https://celld.dev/ · https://celld.dev/docs · https://celld.dev/docs/cloudflare-compat · https://celld.dev/docs/limitations
- https://celld.dev/docs/services/workers · https://celld.dev/docs/services/r2 · https://celld.dev/docs/services/queues · https://celld.dev/docs/services/workflows · https://celld.dev/docs/services/containers
- https://celld.dev/docs/wasm · https://github.com/denoland/celld/blob/main/README.md
- https://developers.cloudflare.com/workers/runtime-apis/webassembly/ · https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript · https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/images/optimization/features/

Codecs and libraries:
- https://github.com/jamsinclair/jSquash (+ examples/cloudflare-worker-esm-format, npm registry `@jsquash/jpeg`, `@jsquash/resize`)
- https://github.com/kleisauke/wasm-vips/issues/2 · https://github.com/kleisauke/cf-worker-wasm-vips
- https://github.com/fineshopdesign/cf-wasm/blob/main/packages/photon/README.md · https://github.com/dlemstra/magick-wasm
- https://ffmpegwasm.netlify.app/docs/overview · https://ffmpegwasm.netlify.app/docs/faq
- https://github.com/gpac/mp4box.js · https://github.com/Vanilagy/mediabunny
- https://github.com/mozilla/pdf.js (+ examples/node/pdf2png/pdf2png.mjs, examples/learning/helloworld.html)
- https://github.com/ArtifexSoftware/mupdf.js · https://www.npmjs.com/package/@embedpdf/pdfium · https://github.com/urish/pdfium-wasm/blob/master/README.md · https://github.com/Hopding/pdf-lib
- https://caniuse.com/webcodecs · https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder · https://developer.mozilla.org/en-US/docs/Web/API/ImageData/data

Prior art:
- https://github.com/longern/FlareDrive (+ src/app/transfer.ts, functions/webdav/put.ts, src/FileGrid.tsx)
- https://github.com/fanchenggang/Davflare (+ src/AuthThumbnail.tsx) · https://github.com/sagan/FlareDrive · https://github.com/abersheeran/r2-webdav

Repo context (Vinnodrive v1, for contrast only):
- apps/web/src/components/dashboard/file-thumbnail.tsx · apps/web/src/components/dashboard/file-preview-modal.tsx
