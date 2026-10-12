// Directives that carry a value ("max-image-preview:none") are not user-agent prefixes and must not be read as the "none" shorthand.
const VALUE_DIRECTIVES = /^(max-snippet|max-image-preview|max-video-preview|unavailable_after)$/i;

/**
 * True when a robots directive string (meta robots, googlebot meta, X-Robots-Tag) blocks indexing:
 * "noindex", the "none" shorthand (= noindex,nofollow), optionally prefixed with a user agent ("googlebot: noindex").
 */
export function isNoindex(robots?: string | null): boolean {
  if (!robots) return false;
  return robots.split(/[,;]/).some((token) => {
    const m = /^\s*(?:([a-z0-9_-]+)\s*:\s*)?(noindex|none)\s*$/i.exec(token);
    return !!m && !(m[1] && VALUE_DIRECTIVES.test(m[1]));
  });
}
