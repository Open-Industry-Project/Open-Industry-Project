/**
 * `?name` present in the page query. For flag readers on a per-frame path: the parse is memoized on the
 * query string, so a hot caller costs one string compare instead of a URLSearchParams per call, and a test
 * that swaps `location` (or a pushState) is still read fresh. False where there is no `location` (node).
 */
export function hasUrlFlag(name: string): boolean {
  if (typeof location === 'undefined') return false
  const search = location.search
  if (search !== cachedSearch) {
    cachedSearch = search
    cachedParams = new URLSearchParams(search)
  }
  return cachedParams!.has(name)
}

let cachedSearch: string | null = null
let cachedParams: URLSearchParams | null = null
