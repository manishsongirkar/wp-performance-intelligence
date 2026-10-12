/**
 * URLs of a srcset / imagesrcset value, following the WHATWG parsing rules: a candidate URL is a run of non-whitespace
 * characters, so commas INSIDE a URL (CDN transforms such as /c_w100,h50/x.jpg, data: URIs) are kept, and a trailing comma ends
 * a candidate that has no descriptor.
 */
export function parseSrcset(input?: string): string[] {
  const s = input ?? "", out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i]!)) i++;
    if (i >= s.length) break;
    const start = i;
    while (i < s.length && !/\s/.test(s[i]!)) i++;
    let url = s.slice(start, i);
    if (url.endsWith(",")) url = url.replace(/,+$/, "");
    else {
      // skip the descriptors, up to the next comma that is not inside parentheses
      let depth = 0;
      while (i < s.length) {
        const c = s[i]!;
        if (c === "(") depth++; else if (c === ")") depth = Math.max(0, depth - 1);
        else if (c === "," && depth === 0) { i++; break; }
        i++;
      }
    }
    if (url) out.push(url);
  }
  return out;
}
