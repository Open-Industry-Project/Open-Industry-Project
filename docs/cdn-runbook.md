# Hosting on Cloudflare Pages

`www.openindustryproject.org` is served by the `oip-web` Cloudflare Pages project. DNS is on Cloudflare, and a push
to `main` deploys via `.github/workflows/deploy-pages.yml`. `collab.openindustryproject.org` is an unproxied A record
to the collab server, so its WebSocket and TLS go straight to that machine ([server/DEPLOY.md](../server/DEPLOY.md)).
This document covers the dashboard configuration, the hosting measurements that matter, the hosting traps with
their fixes, and the recovery plan.

## Measurements

`npm run edge-bench` measures the site with identity encoding and 6 parallel requests over keep-alive connections, in
the same minute as two public CDNs for calibration. From a US machine Pages serves cached assets from the edge at
about 10 MB/s with a 100 to 300 ms warm TTFB. When the site is far slower than both calibration CDNs, the origin is
the bottleneck. When all three are similar, the local link is.

A cold `/app/` visit issues about 100 requests for about 8 MB. Over 6 connections that is about 16 sequential
first-byte waits, so latency matters more than bandwidth. Cutting round trips gives back more than removing megabytes.

Cloudflare compresses `application/wasm` itself, so there are no hand-made brotli files. There is one host, so there
is no host switch in the build. The `no-store` shell is a redundant safety net: Pages does not strip headers on 304s,
checked in WebKit (see AGENTS.md).

`npm run smoke-prod` ([scripts/smoke-prod.mjs](../scripts/smoke-prod.mjs)) runs after every deploy, previews
included, against `www`. It checks that `/app/` carries COOP, COEP and CORP and `no-store`, that the wasm arrives
compressed (brotli bytes must inflate to valid wasm), that `/assets/` is served `immutable` and `/models/` with a
`max-age`, that a versioned model URL serves this deployment's bytes, that a missing `/assets/` file is a 404 nothing
caches, that an `/app/` deep link gets the editor shell, that `/plc/` and its manifest are served, that `/st/`
answers a 301 to `/plc/`, and that the collab server accepts a WebSocket upgrade. It does not check the apex redirect.

## Dashboard configuration

- `www` is the Pages custom domain. The apex redirects to `www` with a Cloudflare redirect rule that keeps the path
  and query, so an apex deep link such as `/app/?scene=demo` still arrives.
- A cache rule caches `/assets/`, `/models/`, `/textures/`, `/fonts/` and `/thumbnails/` at the edge.
- Rocket Loader and Email Obfuscation are off. Both rewrite the HTML on its way out: Rocket Loader defers and
  reorders the page's script tags, and Email Obfuscation injects a decoding script. The site serves the HTML the build
  produced and the gates tested.
- SSL is Full (strict), so the edge verifies the certificate of whatever it connects to.

## Why there is a top-level `404.html`

**Symptom.** After a deploy the editor can fail to load with `Failed to load module script ...
MIME type of "text/html"` for some chunks, while each of them serves correct JS to a fresh `curl`.

**Mechanism.** With no top-level `404.html`, Pages treats a project as an SPA and answers any path
it cannot resolve with `/index.html` at **200**. A file uploaded by a deploy is not readable at every POP
the instant the new shell is (smoke-prod retries around this). So a request for a new chunk in that window
gets the landing page, and the `/assets/*` block in `_headers` stamps it
`public, max-age=31536000, immutable`. Three caches then keep it:

- the edge (`.js` is cached by extension, so a probe for a nonexistent chunk goes `MISS` then `HIT`),
- the browser (immutable, so a plain reload never re-asks),
- the service worker's precache (workbox takes any 200).

Local tooling does not show this when `e2e/_edge-server.mjs` answers a miss with a plain 404.

**Fix.** `public/404.html` turns SPA mode off. A miss is a 404 with `Cache-Control: no-store` (Pages
overrides the `_headers` value on 404s), so the race costs one failed load and recovers on the next, and
workbox refuses to precache it. Pages also canonicalises `/app/index.html` to `/app/`, so a
`/app/* /app/index.html 200` rewrite is a miss and every `/app/<path>` would get the landing. The rewrite target is
`/app/`. `smoke-prod` asserts both.

**Cleanup if chunks were poisoned.** The 404 stops new poisoning but can't reach what is already cached. Purge the
zone cache (dashboard, Caching, Configuration, Purge Everything; the Pages deploy token cannot purge) and clear
site data in any browser that loaded during the window. Browsers that took the bad copy keep it
until those chunk URLs change.

## Why model and texture URLs carry a version

**Mechanism.** The zone cache rule (see "Dashboard configuration") caches `/models/`, `/textures/` and
`/thumbnails/` at the edge, and a Pages deployment does not purge the zone cache. With a bare URL, a changed file
keeps its name and the edge serves the old copy until its `max-age=86400` runs out, while dev shows the new one.
`/assets/*` doesn't have the problem because vite hashes those names.

**Fix.** The app requests every file under those three directories versioned, `?v=<content hash>`
([src/core/assetVersions.ts](../src/core/assetVersions.ts)). The edge keys on the query string, so a
changed file has a URL no cache has seen. The build computes the table
([scripts/lib/asset-versions.mjs](../scripts/lib/asset-versions.mjs): source bytes, salted with the
optimizer script and its tool versions) and vite.config.ts injects it into the bundle and the HTML
pages' asset URLs. The service worker caches versioned URLs CacheFirst. `_headers` keeps a day on
these paths, since it matches the path and cannot tell a versioned request from a bare one.
`assetVersions.test.ts` fails on a new fetch site that skips the helper, and `smoke-prod` asserts the
bundle carries a version and that the versioned URL serves the deployment's bytes. **No purge is
needed after a model change.** One is only needed for a bare URL an older client asks for.

## Decoded texture residency

Bytes on the wire are not the constraint on a phone. **Decoded** bytes in GPU memory are, and the
optimizer's resize sets them. `e2e/probes/texture-residency.mjs` sums every texture
reachable from the live demo scene as `w * h * 4 * 4/3` (RGBA + mips):

| asset set | decoded |
|---|---|
| `public/` - what `npm run dev` serves, including to a phone on your LAN | about 450 MB |
| `dist/` - what ships (`OIP_DEV_PROD_ASSETS=1` to serve it in dev) | about 240 MB |
| `dist/` with `GLB_TEX_CAPS` (embedded AGV/Box/Pallet normal + ORM maps) | about 180 MB |

[e2e/verify-texture-residency.mjs](../e2e/verify-texture-residency.mjs) enforces a ceiling on the last row.

Texture dimensions are almost all of it. Render targets are small next to that: at a phone viewport the HDR scene
target plus depth plus mask is under 20 MB even at DPR 2, so the pixel ratio moves a few percent of the total. The
four 2048² textures, three of them the six-axis robot's maps, are the largest single cost.
Capping them to 1024 would save about 64 MB.

**Why it matters beyond load time.** Dev assets decode to nearly twice the GPU memory of prod, which on a phone can
cost the WebGL context, and Safari's context restore can bring textures back black. `optimize-assets.mjs` resizes to
`TEX_CAP` 2048 with tighter per-file caps (the building drops to 1024), which is the whole difference. AGENTS.md's
"never judge asset behaviour from `npm run dev`" applies to memory, not just bandwidth. A device measurement must
state which asset set it used (`npm run preview:prod -- --host` serves `dist/` to the LAN for this).

## If Pages has to be abandoned

There is no warm standby. Recovery means standing up another host (the build output is plain static files, so any
static host works), pointing `www` at it in Cloudflare DNS, and porting `public/_headers` to whatever that host uses
for response headers.

This does not cover a Cloudflare-wide incident. DNS, CDN and hosting are all on Cloudflare, so such an incident takes
the site down and also prevents repointing `www`. This concentration is an accepted risk.

Before deciding Pages has to be abandoned, check the things that could regress: WebKit cross-origin isolation on first
load and reload, the collab WebSocket, wasm arriving compressed, and the apex redirect. `npm run smoke-prod` covers the
collab WebSocket and the wasm. The other two are checked by hand.
