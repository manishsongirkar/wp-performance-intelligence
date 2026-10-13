import type { EvidenceItem, LighthouseExperiment } from "../../contracts/src/types.js";
import { fixesForRule, type Fix } from "./fixes.js";
import { safeUrl, php, sh, cmt, attr, pathOf } from "./escape.js";
import { parseSrcset } from "../../audit-core/src/srcset.js";

export interface ExactFixContext {
  pageUrl: string;
  evidence: Record<string, EvidenceItem[]>;
  metrics: { lcpMs?: number; fcpMs?: number; tbtMs?: number; cls?: number; ttfbMs?: number };
  /** LCP element from the browser measurement, if any. */
  lcpElement?: { tag: string; url: string | null } | null;
  /** <link rel="preload"> tags found in the page HTML, to detect fixes that are already applied. */
  preloads?: Array<{ href: string; as: string | null; fetchPriority: string | null; srcsetUrls?: string[] }>;
  /** Facts from the page HTML. When absent, the report cannot tell what is already applied and says so. */
  scripts?: Array<{ src: string; defer: boolean; async: boolean; module: boolean }>;
  stylesheets?: Array<{ href: string; async: boolean }>;
  preconnects?: string[];
  imgTags?: Array<{ src: string; srcsetUrls: string[]; fetchPriority: string | null; loading: string | null }>;
  /** LCP phase timings and the what-if experiment from the Lighthouse run. */
  lcpPhases?: Array<{ phase: string; ms: number }>;
  /** Lighthouse 13's own checks of how the LCP image is discovered: authoritative for the rendered page. */
  lcpDiscovery?: { priorityHinted?: boolean; requestDiscoverable?: boolean; eagerlyLoaded?: boolean };
  experiments?: LighthouseExperiment[];
  /** Request chain behind the page (Lighthouse network dependency tree). */
  networkTree?: { maxDepth: number; longestMs: number; nodes: Array<{ url: string; depth: number; ms: number; bytes?: number }> };
  /** Emulated viewport width in CSS px (to tell whether an image is full-bleed). */
  viewportWidth?: number;
  /** Shell command that re-runs this report against the saved baseline. */
  rerunCommand?: string;
}
export interface ExactFixGroup { area: string; measured: string; fixes: Fix[]; /** Fixes detected as already in place on the page. */ applied?: string[]; note?: string }

// ---- small helpers ----
const originOf = (u: string) => { try { return new URL(u).origin; } catch { return ""; } };
const kb = (n?: number) => (n === undefined ? "?" : n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);
const secs = (ms?: number) => (ms === undefined ? "?" : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
const same = (a: string, b: string) => { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } };
const sizeless = (p: string) => p.replace(/-\d+x\d+(\.[a-z0-9]+)$/i, "$1"); // WordPress size suffix: hero-1536x682.webp -> hero.webp
const CONVERTIBLE = /\.(png|jpe?g|tiff?)(\?|$)/i; // what cwebp can read: never .webp/.avif (already modern), .svg or .gif
const FONT_TYPE: Record<string, string> = { woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf" };
const fontType = (url: string) => FONT_TYPE[/\.([a-z0-9]+)(\?|$)/i.exec(url)?.[1]?.toLowerCase() ?? ""];

/**
 * Multi-line shell snippets run inside `bash`, fed through a quoted heredoc. Pasted straight into an interactive zsh (macOS default)
 * a `#` comment line is an error and arrays/word-splitting behave differently; inside bash the snippet behaves the same everywhere,
 * `set -e` ends only the inner bash (never the user's terminal), and a `cd` does not move the user's shell.
 */
const bashBlock = (body: string) => {
  if (/^WPI$/m.test(body)) throw new Error("snippet contains the heredoc terminator");
  return `bash <<'WPI'\n${body}\nWPI`;
};

/** A condition that is true only on the audited page (path AND query: "/?p=12" is not the front page). */
function pageCondition(pageUrl: string): string {
  let u: URL;
  try { u = new URL(pageUrl); } catch { return "false"; }
  if (u.search) return `isset( $_SERVER['REQUEST_URI'] ) && wp_unslash( $_SERVER['REQUEST_URI'] ) === ${php(u.pathname + u.search)}`;
  if (u.pathname === "/") return "is_front_page()";
  const p = u.pathname.endsWith("/") ? u.pathname : `${u.pathname}/`;
  return `isset( $_SERVER['REQUEST_URI'] ) && trailingslashit( strtok( wp_unslash( $_SERVER['REQUEST_URI'] ), '?' ) ) === ${php(p)}`;
}
const urlItems = (items: EvidenceItem[] = []) => items.filter((i) => safeUrl(i.url));
const lines = (items: EvidenceItem[], note: (i: EvidenceItem) => string, quote: (s: string) => string, indent: string) =>
  items.map((i) => `${indent}${quote(pathOf(i.url!))}, // ${cmt(note(i))}`).join("\n");

const FIND_HANDLE = (needles: string) => `// TEMPORARY helper: prints the WordPress handle for each script as an HTML comment (admins only). Remove after use.
add_action( 'wp_print_footer_scripts', function () {
	global $wp_scripts;
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	$needles = array(
${needles}
	);
	foreach ( $wp_scripts->registered as $handle => $script ) {
		foreach ( $needles as $needle ) {
			if ( $script->src && false !== strpos( $script->src, $needle ) ) {
				echo '<!-- WPI handle: ' . esc_html( $handle ) . ' -->' . "\\n";
			}
		}
	}
}, 100 );`;

/** Downloads the exact images, converts a COPY to WebP, and leaves the originals alone. Works from any folder. */
const convertBody = (items: EvidenceItem[]) => `# Works from any folder, for local, staging or live sites. Needs cwebp: brew install webp   (or apt install webp)
command -v cwebp >/dev/null || { echo "cwebp not found: install it first (brew install webp)"; exit 1; }
OUT=./webp-out && mkdir -p "$OUT"
urls=(
${items.map((i) => `  ${sh(i.url!)} # ${cmt(`${kb(i.totalBytes)}, ~${kb(i.wastedBytes)} saveable`)}`).join("\n")}
)
for u in "\${urls[@]}"; do
  f="$OUT/$(basename "\${u%%\\?*}")"
  if curl -sSf "$u" -o "$f"; then
    cwebp -quiet -q 82 "$f" -o "\${f%.*}.webp" && ls -l "$f" "\${f%.*}.webp"
  else
    echo "download failed: $u"
  fi
done
echo "WebP files are in $OUT"`;
const CONVERT_NOTE = "Upload the .webp files in place of the originals (Media Library or your build), keeping the same dimensions, then regenerate sizes and compare quality visually. Only PNG/JPEG/TIFF files are listed because cwebp reads those.";

export function exactFixes(ctx: ExactFixContext): ExactFixGroup[] {
  const ev = ctx.evidence, m = ctx.metrics, cond = pageCondition(ctx.pageUrl), groups: ExactFixGroup[] = [];

  // ================= LCP =================
  const lcpEv = ev["largest-contentful-paint-element"]?.[0];
  const browserUrl = safeUrl(ctx.lcpElement?.url ?? undefined);
  const rawSnippet = lcpEv?.snippet ?? "";
  const attrOf = (html: string, name: string) => { const x = new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`, "i").exec(html); return x ? (x[1] ?? x[2]) : undefined; };
  const absUrl = (u: string) => { try { return new URL(u, ctx.pageUrl).href; } catch { return undefined; } };
  // Lighthouse 13 cuts long attribute values in snippets and marks the cut with "…": such a URL is a prefix, not a URL.
  const cutOff = (v?: string) => !!v && v.includes("\u2026");
  const rawSrc = attrOf(rawSnippet, "src"), rawSrcset = attrOf(rawSnippet, "srcset"), rawSizes = attrOf(rawSnippet, "sizes");
  const snipSrc = cutOff(rawSrc) ? undefined : rawSrc, snipSrcset = cutOff(rawSrcset) ? undefined : rawSrcset, snipSizes = cutOff(rawSizes) ? undefined : rawSizes;
  const snipPaths = new Set([snipSrc, ...parseSrcset(snipSrcset)].filter((u): u is string => !!u).map((u) => pathOf(absUrl(u) ?? u)));
  // Same image = same path, or the same file under a WordPress size suffix, or the same file name (CDNs and themes move files between folders).
  const stem = (p: string) => sizeless(p).split("/").pop()!.replace(/\.[a-z0-9]+$/i, "").toLowerCase();
  const matchesSnippet = (u: string) => snipPaths.has(pathOf(u)) || [...snipPaths].some((c) => sizeless(c) === sizeless(pathOf(u)) || stem(c) === stem(pathOf(u)));
  // Lighthouse and the browser can name different elements (other device, or a hero that changes). A snippet that does not describe the
  // browser-measured image must not be used to judge it.
  const snippetUsable = !!rawSnippet && (!browserUrl || snipPaths.size === 0 || matchesSnippet(browserUrl));
  const snippet = snippetUsable ? rawSnippet : "";
  const fromSnippet = snippetUsable && snipSrc ? absUrl(snipSrc) : undefined;
  // A cut-off src is still useful: it is the start of exactly one of the page's images.
  const fromPrefix = (() => {
    if (!cutOff(rawSrc) || !rawSrc) return undefined;
    const prefix = absUrl(rawSrc.split("\u2026")[0]!);
    const hits = prefix ? [...new Set([...(ev["network-requests"] ?? []), ...(ev["modern-image-formats"] ?? []), ...(ev["uses-responsive-images"] ?? [])].map((i) => i.url).filter((u): u is string => !!u && u.startsWith(prefix)))] : [];
    return hits.length === 1 ? hits[0] : undefined;
  })();
  const lcpUrl = browserUrl ?? safeUrl(lcpEv?.url) ?? safeUrl(fromSnippet) ?? safeUrl(fromPrefix);
  if (lcpUrl || (snippetUsable && lcpEv?.selector)) {
    const fixes: Fix[] = [], applied: string[] = [];
    // The browser may load a different size than the preload's href (responsive preload with imagesrcset), so compare candidate SETS:
    // every URL the LCP element can use (loaded file, src, srcset) against every URL the preload can fetch (href, imagesrcset).
    const lcpCandidates = new Set([lcpUrl, fromSnippet, ...(snippetUsable ? parseSrcset(snipSrcset).map(absUrl) : [])].filter((u): u is string => !!u).map(pathOf));
    const preloaded = !!lcpUrl && (ctx.preloads ?? []).some((p) => p.as === "image" && [p.href, ...(p.srcsetUrls ?? [])].filter(Boolean).some((u) => lcpCandidates.has(pathOf(u)) || [...lcpCandidates].some((c) => sizeless(c) === sizeless(pathOf(u)))));
    const imgTag = (ctx.imgTags ?? []).find((t) => [t.src, ...t.srcsetUrls].some((u) => u && lcpCandidates.has(pathOf(u))));
    // Attributes: the rendered element (Lighthouse) and the raw HTML can differ; "already high priority" if EITHER says so, "lazy" if EITHER says so.
    const disc = ctx.lcpDiscovery;                                           // Lighthouse's own verdict on the rendered page
    const attrsKnown = !!snippet || !!imgTag || disc?.priorityHinted !== undefined || disc?.eagerlyLoaded !== undefined;   // with no source at all we must not guess
    const prioritised = (!!snippet && /fetchpriority=["']high["']/i.test(snippet)) || imgTag?.fetchPriority === "high" || disc?.priorityHinted === true;
    const lazy = (!!snippet && /loading=["']lazy["']/i.test(snippet)) || imgTag?.loading === "lazy" || disc?.eagerlyLoaded === false;
    // "No srcset" is claimed only when every available source agrees.
    const hasSrcset = !snippet && !imgTag ? undefined : (!!imgTag && imgTag.srcsetUrls.length > 0) || (!!snippet && /\ssrcset=/i.test(snippet));
    const known = ctx.preloads !== undefined;                                // without the page HTML we cannot say that a preload is missing
    if (preloaded) applied.push("Preload for the LCP image is present");
    if (prioritised) applied.push('fetchpriority="high" is set on the LCP image');
    if (attrsKnown && !lazy) applied.push("The LCP image is not lazy-loaded");
    const attachmentId = /\bwp-image-(\d+)\b/.exec(snippet)?.[1];
    const dims = (ev["uses-responsive-images"] ?? []).concat(ev["modern-image-formats"] ?? []).filter((i) => i.url && lcpUrl && pathOf(i.url) === pathOf(lcpUrl));
    const fullBleed = !!ctx.viewportWidth && dims.some((i) => i.displayWidth !== undefined && Math.abs(i.displayWidth - ctx.viewportWidth!) <= 2);

    if (lcpUrl && !preloaded) {
      // With a srcset the preload must carry imagesrcset/imagesizes, or phones may fetch the hero twice (the preload's file and the srcset's choice).
      const sizesExpr = snipSizes ? php(snipSizes) : fullBleed ? "'100vw'" : "wp_get_attachment_image_sizes( $id, 'full' )";
      const cases = attachmentId ? {
        title: `Preload the LCP image on this page (with its responsive sizes): attachment ${attachmentId}`,
        code: `add_action( 'wp_head', function () {
	if ( ${cond} ) {
		$id     = ${Number(attachmentId)};
		$src    = wp_get_attachment_image_url( $id, 'full' );
		$srcset = wp_get_attachment_image_srcset( $id, 'full' );
		if ( $src ) {
			printf(
				'<link rel="preload" as="image" href="%s"%s fetchpriority="high">' . "\\n",
				esc_url( $src ),
				$srcset ? sprintf( ' imagesrcset="%s" imagesizes="%s"', esc_attr( $srcset ), esc_attr( ${sizesExpr} ) ) : ''
			);
		}
	}
}, 1 );`,
        note: "Reads the srcset from WordPress, so the preload picks the same file as the <img> on every screen size."
      } : snipSrcset ? {
        title: `Preload the LCP image on this page (with its responsive sizes): ${pathOf(lcpUrl)}`,
        code: `add_action( 'wp_head', function () {
	if ( ${cond} ) {
		printf(
			'<link rel="preload" as="image" href="%s" imagesrcset="%s"%s fetchpriority="high">' . "\\n",
			esc_url( ${php(absUrl(snipSrc ?? lcpUrl) ?? lcpUrl)} ),
			esc_attr( ${php(snipSrcset)} ),
			${snipSizes || fullBleed ? `' imagesizes="' . esc_attr( ${snipSizes ? php(snipSizes) : "'100vw'"} ) . '"'` : "''"}
		);
	}
}, 1 );`,
        note: "Copied from the element's own srcset, so it matches what the <img> will load."
      } : {
        title: `Preload the LCP image on this page: ${pathOf(lcpUrl)}`,
        code: `add_action( 'wp_head', function () {
	if ( ${cond} ) {
		printf( '<link rel="preload" as="image" href="%s" fetchpriority="high">' . "\\n", esc_url( ${php(lcpUrl)} ) );
	}
}, 1 );`,
        note: hasSrcset === true ? "This image has a srcset: add imagesrcset and imagesizes copied from the <img> tag, or the browser may fetch two different files." : (known ? undefined : "Could not read the page HTML to check for an existing preload or a srcset.")
      };
      const unread = !known && (attachmentId || snipSrcset) ? "Could not read the page HTML to check for an existing preload." : "";
      fixes.push({ title: cases.title, language: "php", code: cases.code, note: [cases.note, unread].filter(Boolean).join(" ") || undefined });
    }
    if (lcpUrl && attrsKnown && (!prioritised || lazy)) fixes.push({
      title: lazy ? "Remove loading=\"lazy\" and mark that exact <img> as high priority (Gutenberg/post-content images)" : "Mark that exact <img> as high priority and eager (Gutenberg/post-content images)", language: "php",
      code: `add_filter( 'wp_content_img_tag', function ( $tag ) {
	if ( false === strpos( $tag, ${php(pathOf(lcpUrl))} ) ) {
		return $tag;
	}
	$tag = str_replace( array( ' loading="lazy"', " loading='lazy'" ), '', $tag );
	return false === strpos( $tag, 'fetchpriority' ) ? preg_replace( '/<img /', '<img fetchpriority="high" ', $tag, 1 ) : $tag;
} );`,
      note: ctx.lcpElement?.tag && ctx.lcpElement.tag !== "IMG" ? `The LCP element is a <${ctx.lcpElement.tag.toLowerCase()}> (likely a CSS background), so use the preload above; this filter only affects <img> tags.` : "Rendered by theme code instead of post content? Add fetchpriority=\"high\" in that template, or use the wp_get_attachment_image_attributes filter with the same path check."
    });
    // Once discovery and priority are fixed, the LCP time is limited by the image's size: point at the exact file.
    const weight = dims.concat(ev["uses-optimized-images"] ?? []).filter((i) => i.url && lcpUrl && pathOf(i.url) === pathOf(lcpUrl)).sort((a, b) => (b.wastedBytes ?? 0) - (a.wastedBytes ?? 0))[0];
    if (weight && lcpUrl && CONVERTIBLE.test(lcpUrl) && safeUrl(lcpUrl) && same(lcpUrl, ctx.pageUrl)) fixes.push({
      title: `The LCP image itself is heavy: ${kb(weight.totalBytes)}, about ${kb(weight.wastedBytes)} saveable. Convert this exact file`, language: "bash",
      code: bashBlock(convertBody([{ ...weight, url: lcpUrl }])),
      note: CONVERT_NOTE + " Resize it to the largest size it is actually displayed at (keep a large version for desktop)."
    });
    if (snippetUsable && lcpEv?.selector) fixes.push({ title: "Where it is in the DOM (from Lighthouse)", language: "html", code: `<!-- selector -->\n${cmt(lcpEv.selector)}\n\n<!-- element -->\n${snippet.replace(/[\r\n]+/g, " ")}`, note: "Use this to find the template or block that outputs the image." });
    // Responsive image: only when every source agrees the markup has no srcset.
    if (attachmentId && hasSrcset === false) {
      fixes.push({
        title: `Check whether WordPress can build a srcset for attachment ${attachmentId} (the LCP <img> has none)`, language: "bash",
        code: `wp eval 'var_dump( wp_get_attachment_image_srcset( ${Number(attachmentId)}, "full" ) );'\nwp media regenerate ${Number(attachmentId)} --yes`,
        note: "WordPress normally adds srcset to content images. If the first command prints false, the attachment has no smaller sizes yet and the second command creates them (it only touches this one attachment)."
      });
      if (fullBleed) fixes.push({
        title: "Add srcset/sizes to that exact image so phones download a smaller file (full-bleed image: sizes=100vw)", language: "php",
        code: `add_filter( 'wp_content_img_tag', function ( $tag, $context, $attachment_id ) {
	if ( ${Number(attachmentId)} !== (int) $attachment_id || false !== strpos( $tag, ' srcset=' ) ) {
		return $tag;
	}
	$srcset = wp_get_attachment_image_srcset( $attachment_id, 'full' );
	if ( ! $srcset ) {
		return $tag;
	}
	return preg_replace( '/<img /', '<img srcset="' . esc_attr( $srcset ) . '" sizes="100vw" ', $tag, 1 );
}, 10, 3 );`,
        note: "Only changes this attachment, only when no srcset exists, and only when WordPress has smaller sizes, so desktop keeps the large file. sizes=\"100vw\" is right because this image spans the viewport width."
      });
    }

    // Why is LCP what it is? Lighthouse's own phase breakdown, plus the measured what-if experiment.
    const phases = ctx.lcpPhases ?? [], total = phases.reduce((a, p) => a + p.ms, 0);
    const top = [...phases].sort((a, b) => b.ms - a.ms)[0];
    const exp = ctx.experiments?.find((e) => e.id === "block-competing-images");
    const needs = [!preloaded && "a preload", attrsKnown && !prioritised && 'fetchpriority="high"'].filter(Boolean).join(" and ");
    // Lighthouse 13 reports the OBSERVED phases: when the simulated LCP is far above their total, the extra time is the throttled network.
    const throttleGap = !!total && !!m.lcpMs && m.lcpMs > 2500 && m.lcpMs > 2 * total;
    const whatIf = exp ? ` Measured what-if: with ${exp.blocked.length} other heavy images blocked, simulated LCP is ${secs(exp.lcpMs ?? undefined)} instead of ${secs(exp.baselineLcpMs ?? undefined)}.` : "";
    let note: string | undefined;
    if (throttleGap && needs) note = `The image is not yet fully prioritised: add ${needs} (below).`;
    else if (throttleGap) note = `In the unthrottled test the LCP phases add up to only ${secs(total)}, but the simulated slow-connection LCP is ${secs(m.lcpMs)}. The extra time is the throttled network: the page's total bytes, including other large images, compete with the LCP image.${whatIf} Cutting those images' bytes (see Images below) is the lever; marking them low priority is not recommended because they may be above the fold at other breakpoints.`;
    else if (total && top && top.ms / total >= 0.5) {
      const share = Math.round((top.ms / total) * 100);
      if (top.phase === "Load Delay") {
        if (needs) note = `${share}% of LCP is Load Delay: the browser starts loading the image late. Add ${needs} (below).`;
        else note = `${share}% of LCP is Load Delay${preloaded && prioritised ? ", although the image is already preloaded and high priority" : preloaded ? ", although the image is already preloaded" : ""}. The image waits for bandwidth: other large resources download at the same time on the simulated connection.${exp ? ` Measured what-if: with ${exp.blocked.length} other heavy images blocked, simulated LCP is ${secs(exp.lcpMs ?? undefined)} instead of ${secs(exp.baselineLcpMs ?? undefined)}.` : ""} Cutting those images' bytes (see Images below) is the lever; marking them low priority is not recommended because they may be above the fold at other breakpoints.`;
      } else if (top.phase === "Load Time") note = `${share}% of LCP is the image download itself: reduce the image's bytes (format, dimensions).`;
      else if (top.phase === "Render Delay") note = `${share}% of LCP is Render Delay: the image has arrived but painting waits on render-blocking CSS/JS or fonts (see FCP below).`;
      else note = `${share}% of LCP is server response time (TTFB): see the server fixes below.`;
    } else if (applied.length && !fixes.some((f) => /preload|high priority/i.test(f.title))) {
      note = weight ? "Discovery and priority are already optimised, so the remaining LCP time is mostly the image download." : "Discovery and priority are already optimised. If LCP is still slow, check server response time and render-blocking resources below.";
    }
    if (!snippetUsable && rawSnippet && browserUrl) note = [note, "Lighthouse measured a different LCP element than the browser run; this analysis follows the browser's."].filter(Boolean).join(" ");
    // "=" only when the phases really add up to the LCP (Lighthouse 12's simulated breakdown); Lighthouse 13's observed phases are shown as such.
    const addsUp = !!total && !!m.lcpMs && Math.abs(total - m.lcpMs) / m.lcpMs < 0.3;
    const breakdown = total ? (!addsUp ? ` (simulated) · observed phases: ${phases.map((p) => `${p.phase} ${secs(p.ms)}`).join(" + ")}` : ` = ${phases.map((p) => `${p.phase} ${secs(p.ms)}`).join(" + ")}`) : "";
    groups.push({ area: "LCP: Largest Contentful Paint", measured: `LCP ${secs(m.lcpMs)}${breakdown}${lcpUrl ? ` · element ${pathOf(lcpUrl)}` : ""}`, fixes, applied, note });
  }

  // ================= FCP / render blocking / fonts / server =================
  // Never recommend what the page already does: check script attributes, async stylesheets, font preloads and preconnects first.
  const pageKnown = ctx.scripts !== undefined;
  const scriptTags = (url: string) => (ctx.scripts ?? []).filter((x) => pathOf(x.src) === pathOf(url));
  const alreadyDeferred = (url: string) => { const t = scriptTags(url); return t.length > 0 && t.every((x) => x.defer || x.async || x.module); };
  const alreadyAsyncCss = (url: string) => { const t = (ctx.stylesheets ?? []).filter((x) => pathOf(x.href) === pathOf(url)); return t.length > 0 && t.every((x) => x.async); };
  const fcp: Fix[] = [], fcpApplied: string[] = [];
  // Async CSS and deferred scripts change loading order and can cause a flash of unstyled content: not worth the risk once FCP is already Good.
  const fcpGood = m.fcpMs !== undefined && m.fcpMs <= 1800;
  const blocking = fcpGood ? [] : urlItems(ev["render-blocking-resources"]);
  const css = blocking.filter((i) => /\.css(\?|$)/.test(i.url!) && !alreadyAsyncCss(i.url!)), js = blocking.filter((i) => /\.js(\?|$)/.test(i.url!) && !alreadyDeferred(i.url!));
  for (const i of blocking) {
    if (/\.css(\?|$)/.test(i.url!) && alreadyAsyncCss(i.url!)) fcpApplied.push(`${pathOf(i.url!).split("/").pop()} already loads without blocking render`);
    if (/\.js(\?|$)/.test(i.url!) && alreadyDeferred(i.url!)) fcpApplied.push(`${pathOf(i.url!).split("/").pop()} already uses defer/async`);
  }
  const unchecked = pageKnown ? "" : " The page HTML could not be read, so check the page source first: if the tag already has defer or async, skip this.";
  if (css.length) fcp.push({
    title: "Load these render-blocking stylesheets without blocking paint", language: "php",
    code: `add_filter( 'style_loader_tag', function ( $html, $handle, $href ) {
	$async = array(
${lines(css, (i) => `blocks paint ~${secs(i.wastedMs)} (${kb(i.totalBytes)})`, php, "\t\t")}
	);
	foreach ( $async as $needle ) {
		if ( false !== strpos( $href, $needle ) ) {
			return str_replace( "rel='stylesheet'", "rel='preload' as='style' onload=\\"this.onload=null;this.rel='stylesheet'\\"", $html ) . '<noscript>' . $html . '</noscript>';
		}
	}
	return $html;
}, 10, 3 );`,
    note: "Inline the critical above-the-fold CSS first, or the page may flash unstyled. Test on staging." + unchecked
  });
  if (js.length) fcp.push({
    title: "Defer these render-blocking scripts", language: "php",
    code: `add_filter( 'script_loader_tag', function ( $tag, $handle, $src ) {
	$defer = array(
${lines(js, (i) => `blocks paint ~${secs(i.wastedMs)} (${kb(i.totalBytes)})`, php, "\t\t")}
	);
	foreach ( $defer as $needle ) {
		if ( false !== strpos( $src, $needle ) && false === strpos( $tag, ' defer' ) && false === strpos( $tag, ' async' ) ) {
			return str_replace( ' src=', ' defer src=', $tag );
		}
	}
	return $tag;
}, 10, 3 );`,
    note: "Scripts that other inline scripts depend on can break when deferred. Check the browser console." + unchecked
  });
  const preloadedFonts = (f: EvidenceItem) => (ctx.preloads ?? []).some((p) => p.as === "font" && pathOf(p.href) === pathOf(f.url!));
  const allFonts = fcpGood ? [] : urlItems(ev["font-display"]).filter((f) => fontType(f.url!));
  const fonts = allFonts.filter((f) => !preloadedFonts(f)).slice(0, 2);   // preloading many fonts competes with the page's own rendering
  for (const f of allFonts) if (preloadedFonts(f)) fcpApplied.push(`${pathOf(f.url!).split("/").pop()} is already preloaded`);
  if (fonts.length) fcp.push({
    title: "Preload the web fonts that delay text", language: "html",
    code: fonts.map((f) => `<link rel="preload" as="font" type="${fontType(f.url!)}" crossorigin href="${attr(f.url!)}">`).join("\n"),
    note: `Only the ${fonts.length === 1 ? "font" : "first two fonts"} used above the fold are worth preloading.${ctx.preloads === undefined ? " The page HTML could not be read: skip any font the page already preloads." : ""}`
  });
  if (allFonts.length) fcp.push({ title: "Set font-display: swap in the @font-face rule of each flagged font", language: "html", code: "/* In each @font-face rule: */\nfont-display: swap;", note: "Cannot be detected from the page HTML; check your CSS first, it may already be set." });
  const preItems = fcpGood ? [] : urlItems(ev["uses-rel-preconnect"]);
  const preOrigins = [...new Set(preItems.map((i) => originOf(i.url!)).filter(Boolean))];
  const pre = preOrigins.filter((o) => !(ctx.preconnects ?? []).includes(o));
  for (const o of preOrigins) if ((ctx.preconnects ?? []).includes(o)) fcpApplied.push(`preconnect to ${o} is already present`);
  if (pre.length) fcp.push({
    title: "Preconnect to the origins needed early", language: "php",
    code: `add_filter( 'wp_resource_hints', function ( $urls, $relation ) {
	if ( 'preconnect' === $relation ) {
${pre.map((o) => {
  // Font files are fetched in CORS mode: a preconnect without crossorigin is not used for them.
  const font = o.includes("fonts.gstatic.com") || preItems.some((i) => originOf(i.url!) === o && fontType(i.url!));
  return font ? `\t\t$urls[] = array( 'href' => ${php(o)}, 'crossorigin' => 'anonymous' );` : `\t\t$urls[] = ${php(o)};`;
}).join("\n")}
	}
	return $urls;
}, 10, 2 );`,
    note: ctx.preconnects === undefined ? "The page HTML could not be read: skip any origin the page already preconnects to." : undefined
  });
  if ((m.ttfbMs ?? 0) > 600) fcp.push(...fixesForRule("server-response-time", { pageUrl: ctx.pageUrl }));
  if (fcp.length || fcpApplied.length) groups.push({ area: "FCP: First Contentful Paint", measured: `FCP ${secs(m.fcpMs)}${m.ttfbMs ? ` · TTFB ${secs(m.ttfbMs)}` : ""}${blocking.length ? ` · ${blocking.length} render-blocking file(s)` : ""}`, fixes: fcp, applied: fcpApplied });

  // ================= TBT / main-thread JS =================
  const boot = urlItems(ev["bootup-time"]).filter((i) => /\.js(\?|$)/.test(i.url!) && (i.scriptingMs ?? 0) >= 40).slice(0, 6);
  // Only when blocking time is actually above the "Good" limit (200 ms): never suggest script changes for a metric that is already fine.
  if (boot.length && (m.tbtMs ?? 0) > 200) {
    const costly = boot.map((b) => `${pathOf(b.url!).split("/").pop()} ${secs(b.scriptingMs)}`).join(", ");
    const needDefer = boot.filter((b) => !alreadyDeferred(b.url!)), deferred = boot.filter((b) => alreadyDeferred(b.url!));
    const fx: Fix[] = [];
    if (needDefer.length) fx.push({
      title: "Defer the scripts with the highest execution cost", language: "php",
      code: `add_filter( 'script_loader_tag', function ( $tag, $handle, $src ) {
	$defer = array(
${lines(needDefer, (i) => `${secs(i.scriptingMs)} scripting, ${secs(i.wastedMs ?? i.durationMs)}`, php, "\t\t")}
	);
	foreach ( $defer as $needle ) {
		if ( false !== strpos( $src, $needle ) && false === strpos( $tag, ' defer' ) && false === strpos( $tag, ' async' ) ) {
			return str_replace( ' src=', ' defer src=', $tag );
		}
	}
	return $tag;
}, 10, 3 );`,
      note: pageKnown ? undefined : "The page HTML could not be read, so check the page source first: if the tag already has defer or async, skip this."
    });
    fx.push({
      title: "Find the WordPress handle for each of these scripts (to dequeue or conditionally load them)", language: "php",
      code: FIND_HANDLE(lines(boot, () => "heavy script", php, "\t\t")),
      note: deferred.length
        ? "These scripts already use defer, so deferring again will not reduce their cost: their own execution time is the problem. Load them only on pages that use them (wp_dequeue_script elsewhere), or start them when the feature scrolls into view."
        : "Then load a script only where it is used, e.g. wp_dequeue_script( 'handle' ) on pages without that block."
    });
    groups.push({ area: "TBT: Total Blocking Time", measured: `TBT ${secs(m.tbtMs)} · top script cost: ${costly}`, fixes: fx, applied: deferred.map((b) => `${pathOf(b.url!).split("/").pop()} already uses defer/async`) });
  }

  // ================= Unused CSS / JS =================
  const unusedCss = urlItems(ev["unused-css-rules"]), unusedJs = urlItems(ev["unused-javascript"]);
  const pct = (i: EvidenceItem) => (i.totalBytes ? Math.round(((i.wastedBytes ?? 0) / i.totalBytes) * 100) : 0);
  const mostly = (list: EvidenceItem[]) => list.filter((i) => pct(i) >= 90);
  const partial = (list: EvidenceItem[]) => list.filter((i) => pct(i) < 90);
  if (unusedCss.length) {
    const fx: Fix[] = [];
    if (partial(unusedCss).length) {
      const sheets = partial(unusedCss).slice(0, 5), names = sheets.map((_, n) => `css${n + 1}.css`);
      fx.push({
        title: "Measure what is really unused: purge a COPY of the stylesheet and list what would be removed", language: "bash",
        code: bashBlock(`# Works from any folder, for local, staging or live sites. Nothing on your site is changed.
set -e
WORK="$(mktemp -d)" && cd "$WORK"
curl -sSf ${sh(ctx.pageUrl)} -o page.html
${sheets.map((i, n) => `curl -sSf ${sh(i.url!)} -o ${names[n]}`).join("\n")}
cat > purgecss.config.cjs <<'JS'
module.exports = {
  content: ['page.html'],
  css: [${names.map((n) => `'${n}'`).join(", ")}],
  output: 'purged/',
  // keep common state classes that JavaScript toggles and a single static page cannot show
  safelist: { standard: [/^(is-|has-|js-|active|open|show|visible|hidden|current)/] }
};
JS
npx -y purgecss --config purgecss.config.cjs > purgecss.log 2>&1 || { cat purgecss.log; exit 1; }
echo
echo "RESULT: what PurgeCSS would remove (copies only, your site is not changed)"
echo "-----------------------------------------------------------------------"
for f in ${names.join(" ")}; do
  grep -o '\\.[A-Za-z_][A-Za-z0-9_-]*' "$f" | grep -vE '\\.(png|jpe?g|gif|svg|webp|woff2?|ttf|eot|css|js)$' | sort -u > "before-$f.txt"
  grep -o '\\.[A-Za-z_][A-Za-z0-9_-]*' "purged/$f" | sort -u > "after-$f.txt"
  comm -23 "before-$f.txt" "after-$f.txt" > "removed-$f.txt"
  B=$(wc -c < "$f" | tr -d ' '); A=$(wc -c < "purged/$f" | tr -d ' ')
  N=$(wc -l < "removed-$f.txt" | tr -d ' ')
  echo
  echo "File:   $f"
  echo "Size:   $((B / 1024)) KB -> $((A / 1024)) KB (saves $(( (B - A) * 100 / (B > 0 ? B : 1) ))%)"
  echo "Classes that would be removed: $N"
  head -25 "removed-$f.txt" | sed 's/^/   /'
  [ "$N" -gt 25 ] && echo "   ... and $((N - 25)) more (full list: $WORK/removed-$f.txt)"
done
echo
echo "Next step: check the list above. A class used on another page, in a menu or in a modal must stay."
echo "Reduced copies are in: $WORK/purged"`),
        note: `${sheets.map((i) => `${pathOf(i.url!)}: ${kb(i.wastedBytes)} of ${kb(i.totalBytes)} unused (${pct(i)}%) as compressed transfer size, so the raw file is larger`).join("; ")}. Do NOT dequeue these files: the used part is needed by this page. A single page cannot show classes that other pages, menus, modals or JavaScript add later, so review the removed-classes list before you ship anything, and add more pages to \`content\` (curl them to page2.html, page3.html…). Ship the reduced CSS through your build (edit the SCSS/source, not the built file) and test on staging.`
      });
    }
    if (mostly(unusedCss).length) fx.push({
      title: "These files are almost entirely unused on this page: don't load them here", language: "php",
      code: `add_action( 'wp_enqueue_scripts', function () {
	if ( ! ( ${cond} ) ) {
		return;
	}
	global $wp_styles;
	$unused = array(
${lines(mostly(unusedCss), (i) => `${kb(i.wastedBytes)} of ${kb(i.totalBytes)} unused (${pct(i)}%)`, php, "\t\t")}
	);
	foreach ( $wp_styles->registered as $handle => $style ) {
		foreach ( $unused as $needle ) {
			if ( $style->src && false !== strpos( $style->src, $needle ) ) {
				wp_dequeue_style( $handle );
			}
		}
	}
}, 100 );`,
      note: "Only this URL is affected. Check pages that use the same stylesheet, and anything shown only after an interaction (menus, modals, tabs). Another stylesheet that depends on this handle may enqueue it again."
    });
    groups.push({ area: "Unused CSS", measured: `${unusedCss.length} stylesheet(s), ${kb(unusedCss.reduce((a, i) => a + (i.wastedBytes ?? 0), 0))} unused`, fixes: fx });
  }
  if (unusedJs.length) {
    const fx: Fix[] = [];
    if (mostly(unusedJs).length) fx.push({
      title: "These scripts did almost nothing on load: don't load them on this page (only if you are sure it never needs them)", language: "php",
      code: `add_action( 'wp_enqueue_scripts', function () {
	if ( ! ( ${cond} ) ) {
		return;
	}
	global $wp_scripts;
	$unused = array(
${lines(mostly(unusedJs), (i) => `${kb(i.wastedBytes)} of ${kb(i.totalBytes)} unused (${pct(i)}%)`, php, "\t\t")}
	);
	foreach ( $wp_scripts->registered as $handle => $script ) {
		foreach ( $unused as $needle ) {
			if ( $script->src && false !== strpos( $script->src, $needle ) ) {
				wp_dequeue_script( $handle );
			}
		}
	}
}, 100 );`,
      note: "Unused on load is not unused overall: menus, cookie banners, sliders and analytics do little until an interaction. Test every interaction on this page after removing a script. Another script that depends on the handle may enqueue it again."
    });
    if (partial(unusedJs).length) fx.push({
      title: "Partly used scripts: find their handles, then load the heavy part on demand", language: "php",
      code: FIND_HANDLE(lines(partial(unusedJs), (i) => `${kb(i.wastedBytes)} of ${kb(i.totalBytes)} unused (${pct(i)}%)`, php, "\t\t")),
      note: "Split the unused part into a dynamic import() in your bundler so it loads only when the feature appears on the page."
    });
    groups.push({ area: "Unused JavaScript", measured: `${unusedJs.length} script(s), ${kb(unusedJs.reduce((a, i) => a + (i.wastedBytes ?? 0), 0))} unused`, fixes: fx });
  }

  // ================= Images =================
  const imgs = new Map<string, EvidenceItem>();
  for (const id of ["modern-image-formats", "uses-optimized-images", "uses-responsive-images", "offscreen-images"]) for (const i of urlItems(ev[id])) { const e = imgs.get(i.url!); if (!e || (i.wastedBytes ?? 0) > (e.wastedBytes ?? 0)) imgs.set(i.url!, i); }
  const list = [...imgs.values()].sort((a, b) => (b.wastedBytes ?? 0) - (a.wastedBytes ?? 0)).slice(0, 10);
  if (list.length) {
    const own = list.filter((i) => same(i.url!, ctx.pageUrl));
    const fx: Fix[] = [];
    const convertible = own.filter((i) => CONVERTIBLE.test(i.url!));
    if (convertible.length) fx.push({
      title: "Download and convert these exact images to WebP (originals are not touched)", language: "bash",
      code: bashBlock(convertBody(convertible)), note: CONVERT_NOTE
    });
    if (own.length) fx.push({
      title: "Regenerate the WordPress sizes for these exact attachments (run in the WordPress folder of that site)", language: "bash",
      code: bashBlock(`IDS=($(wp eval 'foreach ( array( ${own.map((i) => `"${i.url}"`).join(", ")} ) as $u ) { $id = attachment_url_to_postid( $u ); if ( $id ) { echo $id . " "; } }'))
if [ "\${#IDS[@]}" -gt 0 ]; then
  wp media regenerate "\${IDS[@]}" --yes
else
  echo "No matching attachments (resized URLs such as image-300x200.jpg return 0); nothing to regenerate."
fi`),
      note: "Guarded on purpose: with an empty ID list, wp media regenerate would rebuild every image on the site."
    });
    if (convertible.length) fx.push(...fixesForRule("modern-image-formats").slice(0, 1));
    groups.push({ area: "Images (LCP, Speed Index, page weight)", measured: `${list.length} image(s) flagged, ~${kb(list.reduce((a, i) => a + (i.wastedBytes ?? 0), 0))} saveable (largest: ${pathOf(list[0]!.url!).split("/").pop()})`, fixes: fx });
  }

  // ================= CLS =================
  const unsized = urlItems(ev["unsized-images"]);
  const shifting = [...new Set((ev["layout-shifts"] ?? []).map((i) => i.selector).filter((s): s is string => !!s))].slice(0, 5);
  if (unsized.length || shifting.length) groups.push({
    area: "CLS: Cumulative Layout Shift", measured: `CLS ${m.cls ?? "?"}${unsized.length ? ` · ${unsized.length} image(s) without width/height` : ""}${shifting.length ? ` · ${shifting.length} shifting element(s)` : ""}`,
    fixes: unsized.length ? [{
      title: "Print the real width/height of each unsized image, then add them to the markup", language: "bash",
      code: `wp eval 'foreach ( array( ${unsized.map((i) => `"${i.url}"`).join(", ")} ) as $u ) { $m = wp_get_attachment_metadata( attachment_url_to_postid( $u ) ); echo $u . " " . ( $m["width"] ?? "?" ) . "x" . ( $m["height"] ?? "?" ) . "\\n"; }'`,
      note: 'Then output <img … width="W" height="H"> (wp_get_attachment_image does this automatically) so the browser reserves the space.'
    }] : [],
    note: shifting.length ? `Lighthouse attributes the layout shifts to: ${shifting.map((s) => cmt(s)).join("; ")}. Give those elements a reserved size (width/height, aspect-ratio or min-height) so nothing moves when they load.` : undefined
  });


  // ================= Network dependency tree =================
  const tree = ctx.networkTree;
  if (tree && tree.maxDepth >= 1) {
    const nodes = tree.nodes.filter((n) => safeUrl(n.url));
    const already = (u: string) => (ctx.preloads ?? []).some((p) => pathOf(p.href) === pathOf(u)) || fonts.some((f) => f.url === u);
    // Fonts and stylesheets found at depth 1 or more are discovered late (via CSS or script): preloading them starts the request with the HTML.
    const late = nodes.filter((n) => n.depth >= 1 && (fontType(n.url) || (n.depth >= 2 && /\.css(\?|$)/i.test(n.url))) && !already(n.url)).slice(0, 3);   // many preloads compete with the page's own rendering
    const origins = [...new Set(nodes.filter((n) => n.depth >= 1 && !same(n.url, ctx.pageUrl)).map((n) => originOf(n.url)).filter(Boolean))]
      .filter((o) => !(ctx.preconnects ?? []).includes(o) && !pre.includes(o)).slice(0, 2);
    const tfix: Fix[] = [];
    if (late.length) tfix.push({
      title: "Preload the files that are found late in the chain (starts them with the HTML)", language: "php",
      code: `add_action( 'wp_head', function () {
	if ( ! ( ${cond} ) ) {
		return;
	}
${late.map((n) => fontType(n.url)
  ? `\techo '<link rel="preload" as="font" type="${fontType(n.url)}" crossorigin href="' . esc_url( ${php(n.url)} ) . '">' . "\\n"; // ${cmt(`level ${n.depth + 1}, done at ${secs(n.ms)}`)}`
  : `\techo '<link rel="preload" as="style" href="' . esc_url( ${php(n.url)} ) . '">' . "\\n"; // ${cmt(`level ${n.depth + 1}, done at ${secs(n.ms)}`)}`).join("\n")}
}, 1 );`,
      note: "Preloaded files must really be used on this page, or the browser warns and wastes bandwidth. Each file is limited to this page."
    });
    if (origins.length) tfix.push({
      title: "Preconnect to the other origins in the chain", language: "php",
      code: `add_filter( 'wp_resource_hints', function ( $urls, $relation ) {
	if ( 'preconnect' === $relation ) {
${origins.map((o) => `\t\t$urls[] = array( 'href' => ${php(o)}, 'crossorigin' => 'anonymous' );`).join("\n")}
	}
	return $urls;
}, 10, 2 );`
    });
    if (tfix.length) groups.push({
      area: "Network dependency tree", measured: `${tree.maxDepth + 1} levels deep · longest chain ${secs(tree.longestMs)} · ${late.length} late file(s)`, fixes: tfix,
      note: `Longest chain: ${nodes.slice(0, 4).map((n) => pathOf(n.url).split("/").pop()).join(" → ")}`
    });
  }

  // ================= Long main-thread tasks =================
  const longTasks = urlItems(ev["long-tasks"]).filter((i) => (i.durationMs ?? 0) >= 50 && /\.js(\?|$)/i.test(i.url!) && !boot.some((b) => b.url === i.url));
  if (longTasks.length) {
    const outside = longTasks.filter((i) => !same(i.url!, ctx.pageUrl)), inside = longTasks.filter((i) => same(i.url!, ctx.pageUrl) && !alreadyDeferred(i.url!));
    const lfix: Fix[] = [];
    if (outside.length) lfix.push({
      title: "Run these third-party scripts only after the first user input (removes their long tasks from page load)", language: "php",
      code: `add_filter( 'script_loader_tag', function ( $tag, $handle, $src ) {
	if ( ! ( ${cond} ) ) {
		return $tag;
	}
	$delay = array(
${lines(outside, (i) => `long task ${secs(i.durationMs)}`, php, "\t\t")}
	);
	foreach ( $delay as $needle ) {
		if ( false !== strpos( $src, $needle ) ) {
			return '<script type="text/plain" data-wpi-delay="' . esc_url( $src ) . '"></script>' . "\\n";
		}
	}
	return $tag;
}, 10, 3 );
add_action( 'wp_footer', function () {
	?>
	<script>
	( function () {
		var started = false;
		function start() {
			if ( started ) {
				return;
			}
			started = true;
			document.querySelectorAll( 'script[data-wpi-delay]' ).forEach( function ( old ) {
				var s = document.createElement( 'script' );
				s.src = old.getAttribute( 'data-wpi-delay' );
				s.async = false;
				old.parentNode.replaceChild( s, old );
			} );
		}
		[ 'pointerdown', 'keydown', 'scroll', 'touchstart' ].forEach( function ( e ) {
			window.addEventListener( e, start, { once: true, passive: true } );
		} );
	} )();
	</script>
	<?php
}, 99 );`,
      note: "Analytics and chat scripts work this way. If a script has inline code that calls it at once (a `-after` inline script), that code errors until the first input: check the console, and leave such a script out of the list."
    });
    if (inside.length) lfix.push({
      title: "Defer these first-party scripts that cause long tasks", language: "php",
      code: `add_filter( 'script_loader_tag', function ( $tag, $handle, $src ) {
	$defer = array(
${lines(inside, (i) => `long task ${secs(i.durationMs)}`, php, "\t\t")}
	);
	foreach ( $defer as $needle ) {
		if ( false !== strpos( $src, $needle ) && false === strpos( $tag, ' defer' ) && false === strpos( $tag, ' async' ) ) {
			return str_replace( ' src=', ' defer src=', $tag );
		}
	}
	return $tag;
}, 10, 3 );`,
      note: "Deferring moves the work after parsing but does not shorten it. If the long task remains, load the script only on pages that use it (wp_dequeue_script)."
    });
    if (lfix.length) groups.push({ area: "Long main-thread tasks", measured: `${longTasks.length} script(s) with tasks over 50 ms · longest ${secs(Math.max(...longTasks.map((i) => i.durationMs ?? 0)))}`, fixes: lfix });
  }

  if (groups.length && ctx.rerunCommand) groups.push({ area: "Verify the improvement", measured: "Apply on staging first, then re-run to compare against this report.", fixes: [{ title: "Re-run and show before/after deltas", language: "bash", code: ctx.rerunCommand }] });
  return groups;
}
