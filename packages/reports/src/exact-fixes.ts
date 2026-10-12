import type { EvidenceItem, LighthouseExperiment } from "../../contracts/src/types.js";
import { fixesForRule, type Fix } from "./fixes.js";

export interface ExactFixContext {
  pageUrl: string;
  evidence: Record<string, EvidenceItem[]>;
  metrics: { lcpMs?: number; fcpMs?: number; tbtMs?: number; cls?: number; ttfbMs?: number };
  /** LCP element from the browser measurement, if any. */
  lcpElement?: { tag: string; url: string | null } | null;
  /** <link rel="preload"> tags found in the page HTML, to detect fixes that are already applied. */
  preloads?: Array<{ href: string; as: string | null; fetchPriority: string | null }>;
  /** LCP phase timings and the what-if experiment from the Lighthouse run. */
  lcpPhases?: Array<{ phase: string; ms: number }>;
  experiments?: LighthouseExperiment[];
  /** Emulated viewport width in CSS px (to tell whether an image is full-bleed). */
  viewportWidth?: number;
  /** Shell command that re-runs this report against the saved baseline. */
  rerunCommand?: string;
}
export interface ExactFixGroup { area: string; measured: string; fixes: Fix[]; /** Fixes detected as already in place on the page. */ applied?: string[]; note?: string }

// ---- escaping: site-derived values end up in code users paste into their site, so they are filtered AND escaped ----
const SAFE_URL = /^https?:\/\/[A-Za-z0-9._~:/?&=%#@+,;-]+$/;
const safeUrl = (u?: string) => (u && SAFE_URL.test(u) ? u : undefined);
const control = /[\u0000-\u001f\u007f]/g;
const php = (s: string) => `'${s.replace(control, "").replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const sh = (s: string) => `'${s.replace(control, "").replace(/'/g, `'\\''`)}'`;
const cmt = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\*\//g, "* /").slice(0, 160);
const attr = (s: string) => s.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]!);

const pathOf = (u: string) => { try { return new URL(u).pathname; } catch { return u; } };
const originOf = (u: string) => { try { return new URL(u).origin; } catch { return ""; } };
const rel = (u: string) => pathOf(u).replace(/^\//, "");
const kb = (n?: number) => (n === undefined ? "?" : n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);
const secs = (ms?: number) => (ms === undefined ? "?" : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
const same = (a: string, b: string) => { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } };

function pageCondition(pageUrl: string): string {
  const path = pathOf(pageUrl);
  if (path === "/") return "is_front_page()";
  const p = path.endsWith("/") ? path : `${path}/`;
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

export function exactFixes(ctx: ExactFixContext): ExactFixGroup[] {
  const ev = ctx.evidence, m = ctx.metrics, cond = pageCondition(ctx.pageUrl), groups: ExactFixGroup[] = [];

  // ---- LCP ----
  const lcpEv = ev["largest-contentful-paint-element"]?.[0];
  // Lighthouse gives the element's HTML but not always its URL: recover it from src="…" and resolve it against the page.
  const fromSnippet = (() => { const m = /\ssrc=["']([^"']+)["']/.exec(lcpEv?.snippet ?? ""); try { return m ? new URL(m[1]!, ctx.pageUrl).href : undefined; } catch { return undefined; } })();
  const lcpUrl = safeUrl(ctx.lcpElement?.url ?? undefined) ?? safeUrl(lcpEv?.url) ?? safeUrl(fromSnippet);
  if (lcpUrl || lcpEv?.selector) {
    const fixes: Fix[] = [], applied: string[] = [];
    // What is already in place? The element's own HTML says whether it is prioritised/lazy; the page HTML says whether it is preloaded.
    const snippet = lcpEv?.snippet ?? "";
    const prioritised = /fetchpriority=["']high["']/i.test(snippet), lazy = /loading=["']lazy["']/i.test(snippet);
    const preloaded = !!lcpUrl && (ctx.preloads ?? []).some((p) => p.as === "image" && pathOf(p.href) === pathOf(lcpUrl));
    const known = ctx.preloads !== undefined; // without the page HTML we cannot say that a preload is missing
    if (preloaded) applied.push("Preload for the LCP image is present");
    if (prioritised) applied.push('fetchpriority="high" is set on the LCP image');
    if (snippet && !lazy) applied.push("The LCP image is not lazy-loaded");
    if (lcpUrl && !preloaded) fixes.push({
      title: `Preload the LCP image on this page: ${pathOf(lcpUrl)}`, language: "php",
      code: `add_action( 'wp_head', function () {
	if ( ${cond} ) {
		printf( '<link rel="preload" as="image" href="%s" fetchpriority="high">' . "\n", esc_url( ${php(lcpUrl)} ) );
	}
}, 1 );`,
      note: (known ? "" : "Could not read the page HTML to check for an existing preload. ") + "If the theme serves this image with srcset, preload with imagesrcset/imagesizes instead, or the browser may fetch two different files."
    });
    if (lcpUrl && (!prioritised || lazy)) fixes.push({
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
    const weight = lcpUrl ? [...(ev["modern-image-formats"] ?? []), ...(ev["uses-optimized-images"] ?? []), ...(ev["uses-responsive-images"] ?? [])].filter((i) => i.url && pathOf(i.url) === pathOf(lcpUrl)).sort((a, b) => (b.wastedBytes ?? 0) - (a.wastedBytes ?? 0))[0] : undefined;
    if (weight && same(lcpUrl!, ctx.pageUrl)) fixes.push({
      title: `The LCP image itself is heavy: ${kb(weight.totalBytes)}, about ${kb(weight.wastedBytes)} saveable. Convert this exact file`, language: "bash",
      code: `# Run from the WordPress root. Needs cwebp: brew install webp   (or apt install webp)
cwebp -q 82 ${sh(rel(lcpUrl!))} -o ${sh(rel(lcpUrl!).replace(/\.[A-Za-z0-9]+$/, ".webp"))}`,
      note: "Then serve the WebP for this image (re-upload it as WebP, or serve it via the WordPress 6.5+ WebP filter). Resize it to the largest size it is actually displayed at."
    });
    if (lcpEv?.selector) fixes.push({ title: "Where it is in the DOM (from Lighthouse)", language: "html", code: `<!-- selector -->\n${cmt(lcpEv.selector)}\n\n<!-- element -->\n${snippet.replace(/[\r\n]+/g, " ")}`, note: "Use this to find the template or block that outputs the image." });
    // Responsive image: the markup has no srcset, so phones download the full-size file.
    const attachmentId = /\bwp-image-(\d+)\b/.exec(snippet)?.[1];
    const fullBleed = !!lcpEv && !!ctx.viewportWidth && (ev["uses-responsive-images"] ?? []).concat(ev["modern-image-formats"] ?? []).some((i) => i.url && lcpUrl && pathOf(i.url) === pathOf(lcpUrl) && i.displayWidth !== undefined && Math.abs(i.displayWidth - ctx.viewportWidth!) <= 2);
    if (attachmentId && snippet && !/\ssrcset=/i.test(snippet)) {
      fixes.push({
        title: `Check whether WordPress can build a srcset for attachment ${attachmentId} (the LCP <img> has none)`, language: "bash",
        code: `wp eval 'var_dump( wp_get_attachment_image_srcset( ${Number(attachmentId)}, "full" ) );'\nwp media regenerate ${Number(attachmentId)} --yes   # if the output above is false`,
        note: "WordPress normally adds srcset to content images. If this prints false, the attachment has no smaller sizes yet; regenerating creates them."
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
    const prioritisedAndPreloaded = preloaded && prioritised;
    let note: string | undefined;
    if (total && top && top.ms / total >= 0.5) {
      const share = Math.round((top.ms / total) * 100);
      if (top.phase === "Load Delay") note = prioritisedAndPreloaded
        ? `${share}% of LCP is Load Delay, although the image is already preloaded and high priority. The image waits for bandwidth: other large resources download at the same time on the simulated connection.${exp ? ` Measured what-if: with ${exp.blocked.length} other heavy images blocked, simulated LCP is ${secs(exp.lcpMs ?? undefined)} instead of ${secs(exp.baselineLcpMs ?? undefined)}.` : ""} Cutting those images' bytes (see Images below) is the lever; marking them low priority is not recommended because they may be above the fold at other breakpoints.`
        : `${share}% of LCP is Load Delay: the browser starts loading the image late. Preload it and mark it high priority (below).`;
      else if (top.phase === "Load Time") note = `${share}% of LCP is the image download itself: reduce the image's bytes (format, dimensions).`;
      else if (top.phase === "Render Delay") note = `${share}% of LCP is Render Delay: the image has arrived but painting waits on render-blocking CSS/JS or fonts (see FCP below).`;
      else note = `${share}% of LCP is server response time (TTFB): see the server fixes below.`;
    } else if (applied.length && !fixes.some((f) => /preload|high priority/i.test(f.title))) {
      note = weight ? "Discovery and priority are already optimised, so the remaining LCP time is mostly the image download." : "Discovery and priority are already optimised. If LCP is still slow, check server response time and render-blocking resources below.";
    }
    const breakdown = total ? ` = ${phases.map((p) => `${p.phase} ${secs(p.ms)}`).join(" + ")}` : "";
    groups.push({ area: "LCP: Largest Contentful Paint", measured: `LCP ${secs(m.lcpMs)}${breakdown}${lcpUrl ? ` · element ${pathOf(lcpUrl)}` : ""}`, fixes, applied, note });
  }

  // ---- FCP / render blocking / fonts / server ----
  const fcp: Fix[] = [];
  const blocking = urlItems(ev["render-blocking-resources"]);
  const css = blocking.filter((i) => /\.css(\?|$)/.test(i.url!)), js = blocking.filter((i) => /\.js(\?|$)/.test(i.url!));
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
    note: "Inline the critical above-the-fold CSS first, or the page may flash unstyled. Test on staging."
  });
  if (js.length) fcp.push({
    title: "Defer these render-blocking scripts", language: "php",
    code: `add_filter( 'script_loader_tag', function ( $tag, $handle, $src ) {
	$defer = array(
${lines(js, (i) => `blocks paint ~${secs(i.wastedMs)} (${kb(i.totalBytes)})`, php, "\t\t")}
	);
	foreach ( $defer as $needle ) {
		if ( false !== strpos( $src, $needle ) && false === strpos( $tag, ' defer' ) ) {
			return str_replace( ' src=', ' defer src=', $tag );
		}
	}
	return $tag;
}, 10, 3 );`,
    note: "Scripts that other inline scripts depend on can break when deferred. Check the browser console."
  });
  const fonts = urlItems(ev["font-display"]);
  if (fonts.length) fcp.push({
    title: "Preload the web fonts that delay text and set font-display: swap", language: "html",
    code: `${fonts.map((f) => `<link rel="preload" as="font" type="font/${/\.woff2/.test(f.url!) ? "woff2" : "woff"}" crossorigin href="${attr(f.url!)}">`).join("\n")}\n\n/* In the @font-face rule for each font: */\nfont-display: swap;`
  });
  const pre = [...new Set(urlItems(ev["uses-rel-preconnect"]).map((i) => originOf(i.url!)).filter(Boolean))];
  if (pre.length) fcp.push({
    title: "Preconnect to the origins needed early", language: "php",
    code: `add_filter( 'wp_resource_hints', function ( $urls, $relation ) {
	if ( 'preconnect' === $relation ) {
${pre.map((o) => `\t\t$urls[] = ${php(o)};`).join("\n")}
	}
	return $urls;
}, 10, 2 );`
  });
  if ((m.ttfbMs ?? 0) > 600) fcp.push(...fixesForRule("server-response-time"));
  if (fcp.length) groups.push({ area: "FCP: First Contentful Paint", measured: `FCP ${secs(m.fcpMs)}${m.ttfbMs ? ` · TTFB ${secs(m.ttfbMs)}` : ""}${blocking.length ? ` · ${blocking.length} render-blocking file(s)` : ""}`, fixes: fcp });

  // ---- TBT / main-thread JS ----
  const boot = urlItems(ev["bootup-time"]).filter((i) => !same(i.url!, ctx.pageUrl) || /\.js(\?|$)/.test(i.url!)).filter((i) => /\.js(\?|$)/.test(i.url!) && (i.scriptingMs ?? 0) >= 40).slice(0, 6);
  // Only when blocking time is actually above the "Good" limit (200 ms): never suggest script changes for a metric that is already fine.
  if (boot.length && (m.tbtMs ?? 0) > 200) groups.push({
    area: "TBT: Total Blocking Time", measured: `TBT ${secs(m.tbtMs)} · top script cost: ${boot.map((b) => `${pathOf(b.url!).split("/").pop()} ${secs(b.scriptingMs)}`).join(", ")}`,
    fixes: [{
      title: "Defer the scripts with the highest execution cost", language: "php",
      code: `add_filter( 'script_loader_tag', function ( $tag, $handle, $src ) {
	$defer = array(
${lines(boot, (i) => `${secs(i.scriptingMs)} scripting, ${secs(i.wastedMs ?? i.durationMs)}`, php, "\t\t")}
	);
	foreach ( $defer as $needle ) {
		if ( false !== strpos( $src, $needle ) && false === strpos( $tag, ' defer' ) ) {
			return str_replace( ' src=', ' defer src=', $tag );
		}
	}
	return $tag;
}, 10, 3 );`
    }, {
      title: "Find the WordPress handle for each of these scripts (to dequeue or conditionally load them)", language: "php",
      code: FIND_HANDLE(lines(boot, () => "heavy script", php, "\t\t")),
      note: "Then load a script only where it is used, e.g. wp_dequeue_script( 'handle' ) on pages without that block."
    }]
  });

  // ---- Unused CSS / JS ----
  const unusedCss = urlItems(ev["unused-css-rules"]), unusedJs = urlItems(ev["unused-javascript"]);
  const pct = (i: EvidenceItem) => (i.totalBytes ? Math.round(((i.wastedBytes ?? 0) / i.totalBytes) * 100) : 0);
  const mostly = (list: EvidenceItem[]) => list.filter((i) => pct(i) >= 90);
  const partial = (list: EvidenceItem[]) => list.filter((i) => pct(i) < 90);
  if (unusedCss.length) {
    const fx: Fix[] = [];
    if (partial(unusedCss).length) fx.push({
      title: "Measure what is really unused, then ship the reduced file from your build", language: "bash",
      code: `# Run from the WordPress root. Writes purged copies to ./purged (originals untouched).
curl -sk ${sh(ctx.pageUrl)} -o /tmp/page.html
npx purgecss --css ${partial(unusedCss).map((i) => sh(rel(i.url!))).join(" ")} --content /tmp/page.html --output ./purged
# Compare sizes:
ls -l ${partial(unusedCss).map((i) => sh(rel(i.url!))).join(" ")} ./purged`,
      note: `${partial(unusedCss).map((i) => `${pathOf(i.url!)}: ${kb(i.wastedBytes)} of ${kb(i.totalBytes)} unused (${pct(i)}%)`).join("; ")}. Do NOT dequeue these files: the used part is needed by this page. Purge one page only finds that page's classes, so safelist dynamic classes and edit the SCSS/source, not the built file. Better long-term fix: load per-block or per-template CSS.`
    });
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
      note: "Only this URL is affected. Check other pages that use the same stylesheet."
    });
    groups.push({ area: "Unused CSS", measured: `${unusedCss.length} stylesheet(s), ${kb(unusedCss.reduce((a, i) => a + (i.wastedBytes ?? 0), 0))} unused`, fixes: fx });
  }
  if (unusedJs.length) {
    const fx: Fix[] = [];
    if (mostly(unusedJs).length) fx.push({
      title: "These scripts are almost entirely unused on this page: don't load them here", language: "php",
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
}, 100 );`
    });
    if (partial(unusedJs).length) fx.push({
      title: "Partly used scripts: defer them and load the heavy part on demand", language: "php",
      code: FIND_HANDLE(lines(partial(unusedJs), (i) => `${kb(i.wastedBytes)} of ${kb(i.totalBytes)} unused (${pct(i)}%)`, php, "\t\t")),
      note: "Split the unused part into a dynamic import() in your bundler so it loads only when the feature appears on the page."
    });
    groups.push({ area: "Unused JavaScript", measured: `${unusedJs.length} script(s), ${kb(unusedJs.reduce((a, i) => a + (i.wastedBytes ?? 0), 0))} unused`, fixes: fx });
  }

  // ---- Images ----
  const imgs = new Map<string, EvidenceItem>();
  for (const id of ["modern-image-formats", "uses-optimized-images", "uses-responsive-images", "offscreen-images"]) for (const i of urlItems(ev[id])) { const e = imgs.get(i.url!); if (!e || (i.wastedBytes ?? 0) > (e.wastedBytes ?? 0)) imgs.set(i.url!, i); }
  const list = [...imgs.values()].sort((a, b) => (b.wastedBytes ?? 0) - (a.wastedBytes ?? 0)).slice(0, 10);
  if (list.length) {
    const own = list.filter((i) => same(i.url!, ctx.pageUrl));
    const fx: Fix[] = [];
    if (own.length) fx.push({
      title: "Convert these exact files to WebP (originals kept)", language: "bash",
      code: `# Run from the WordPress root. Needs cwebp: brew install webp   (or apt install webp)
files=(
${own.map((i) => `  ${sh(rel(i.url!))} # ${cmt(`${kb(i.totalBytes)}, ~${kb(i.wastedBytes)} saveable`)}`).join("\n")}
)
for f in "\${files[@]}"; do
  cwebp -q 82 "$f" -o "\${f%.*}.webp"
done`,
      note: "Then serve the .webp (for example via a plugin or the WordPress 6.5+ WebP output filter) and compare quality visually."
    }, {
      title: "Regenerate the WordPress sizes for these exact attachments", language: "bash",
      code: `wp media regenerate $(wp eval 'foreach ( array( ${own.map((i) => `"${i.url}"`).join(", ")} ) as $u ) { echo attachment_url_to_postid( $u ) . " "; }') --yes`,
      note: "attachment_url_to_postid() returns 0 for resized URLs such as image-300x200.jpg; use the original upload URL for those."
    });
    fx.push(...fixesForRule("modern-image-formats").slice(0, 1));
    groups.push({ area: "Images (LCP, Speed Index, page weight)", measured: `${list.length} image(s) flagged, ~${kb(list.reduce((a, i) => a + (i.wastedBytes ?? 0), 0))} saveable (largest: ${pathOf(list[0]!.url!).split("/").pop()})`, fixes: fx });
  }

  // ---- CLS ----
  const unsized = urlItems(ev["unsized-images"]);
  if (unsized.length || (m.cls ?? 0) > 0.1) groups.push({
    area: "CLS: Cumulative Layout Shift", measured: `CLS ${m.cls ?? "?"}${unsized.length ? ` · ${unsized.length} image(s) without width/height` : ""}`,
    fixes: unsized.length ? [{
      title: "Print the real width/height of each unsized image, then add them to the markup", language: "bash",
      code: `wp eval 'foreach ( array( ${unsized.map((i) => `"${i.url}"`).join(", ")} ) as $u ) { $m = wp_get_attachment_metadata( attachment_url_to_postid( $u ) ); echo $u . " " . ( $m["width"] ?? "?" ) . "x" . ( $m["height"] ?? "?" ) . "\\n"; }'`,
      note: 'Then output <img … width="W" height="H"> (wp_get_attachment_image does this automatically) so the browser reserves the space.'
    }] : [{ title: "Reserve space for late-loading content", language: "html", code: ".late-banner { min-height: 120px; /* reserve the height it will occupy */ }" }]
  });

  if (groups.length && ctx.rerunCommand) groups.push({ area: "Verify the improvement", measured: "Apply on staging first, then re-run to compare against this report.", fixes: [{ title: "Re-run and show before/after deltas", language: "bash", code: ctx.rerunCommand }] });
  return groups;
}
