/**
 * The content version of an app-served asset, appended to its URL as `?v=<hash>` at the moment it is fetched.
 *
 * /models, /textures and /thumbnails are served under stable names, so without a version a re-exported model keeps
 * its URL and every cache in front of it (the Cloudflare edge, the browser, the service worker) goes on serving the
 * old bytes after a deploy, for up to a day at the edge. A versioned URL is one no cache has seen, so a changed
 * asset arrives on the first load after the deploy that changed it.
 *
 * The table is computed by the production build (scripts/lib/asset-versions.mjs, injected by vite.config.ts) and
 * is absent everywhere else - dev, unit tests, the node CLIs - where every URL passes through unchanged.
 *
 * Add the version at the fetch, never in a stored or compared URL. Caches, the speculative-fetch ledger and part
 * packages all key on the plain path, and a package's `url` is saved into projects and rooms that outlive this build.
 * Every fetch of one asset must use the same URL, or a warm and the real load become two downloads. So every loader
 * and warm goes through `versionedAssetUrl`, and assetVersions.test.ts fails on a raw asset URL handed to one directly.
 */

/** the build's table, replaced by vite.config.ts `define`; undeclared outside a vite build */
declare const __OIP_ASSET_VERSIONS__: Readonly<Record<string, string>> | null | undefined

const BUILD_VERSIONS: Readonly<Record<string, string>> =
  typeof __OIP_ASSET_VERSIONS__ === 'object' && __OIP_ASSET_VERSIONS__ !== null ? __OIP_ASSET_VERSIONS__ : {}

/**
 * `url` with its content version appended, when it names an asset the build versioned (a root-relative path such
 * as `/models/Box.glb`). Anything else - an unknown path, a URL that already has a query, a data: or blob: URL, a
 * remote URL - comes back unchanged.
 */
export function versionedAssetUrl(url: string, versions: Readonly<Record<string, string>> = BUILD_VERSIONS): string {
  const v = Object.hasOwn(versions, url) ? versions[url] : undefined
  return v ? `${url}?v=${v}` : url
}
