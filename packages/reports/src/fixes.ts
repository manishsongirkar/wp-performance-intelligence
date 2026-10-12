import { php, safeUrl, pathOf } from "./escape.js";
import { isNoindex } from "../../contracts/src/robots.js";

export interface Fix { title: string; language: "php" | "html" | "bash" | "apache" | "nginx" | "json" | "sql"; code: string; note?: string }

const CANONICAL: Fix[] = [{
  title: "Restore core canonical output (WordPress prints it for singular pages unless something removed it)",
  language: "php",
  code: `// In a small mu-plugin or your theme's functions.php
add_action( 'init', function () {
	if ( ! has_action( 'wp_head', 'rel_canonical' ) ) {
		add_action( 'wp_head', 'rel_canonical' );
	}
} );`,
  note: "Also check whether an SEO plugin is active and set to output canonicals. A noindex setting can suppress them."
}];

const NOINDEX: Fix[] = [
  { title: "Allow indexing (Settings → Reading → \"Discourage search engines\") — production only", language: "bash", code: "wp option get blog_public      # 0 = discouraged\nwp option update blog_public 1", note: "Keep noindex on local and staging. Only change this for the live site." },
  { title: "Find who sends noindex: header or meta tag", language: "bash", code: "curl -sI https://example.com/ | grep -i x-robots-tag\ncurl -s https://example.com/ | grep -i 'name=.robots.'" },
  { title: "Remove a noindex added by code (WordPress 5.7+)", language: "php", code: `add_filter( 'wp_robots', function ( $robots ) {
	unset( $robots['noindex'], $robots['nofollow'] );
	return $robots;
}, 99 );` }
];

const DESCRIPTION: Fix[] = [{
  title: "Output a meta description (prefer your SEO plugin's per-page field)",
  language: "php",
  code: `add_action( 'wp_head', function () {
	if ( ! is_singular() ) {
		return;
	}
	$text = wp_strip_all_tags( get_the_excerpt() );
	if ( $text ) {
		printf( '<meta name="description" content="%s">' . "\\n", esc_attr( wp_trim_words( $text, 30, '' ) ) );
	}
} );`
}];

const TITLE: Fix[] = [{ title: "Let WordPress manage the <title> tag", language: "php", code: "add_action( 'after_setup_theme', function () {\n\tadd_theme_support( 'title-tag' );\n} );", note: "Remove any hard-coded <title> from header.php." }];

const H1: Fix[] = [{
  title: "Exactly one H1 per page, containing the page's main topic",
  language: "php",
  code: `<?php // single.php / page.php ?>
<h1><?php the_title(); ?></h1>
<?php // In the header/logo use <p> or <div>, not another <h1>. ?>`
}];

const ALT: Fix[] = [
  { title: "Meaningful image: add descriptive alt text", language: "html", code: '<img src="/wp-content/uploads/hero.jpg" alt="Engineer installing a vibrating wire piezometer" width="1200" height="600">' },
  { title: "Decorative image: use an empty alt on purpose", language: "html", code: '<img src="/decor.svg" alt="" width="40" height="40">', note: "An empty alt is valid for decorative images, and this tool does not count it as missing." },
  { title: "List media-library images without alt text", language: "bash", code: `wp db query "SELECT p.ID, p.guid FROM $(wp db prefix)posts p LEFT JOIN $(wp db prefix)postmeta m ON m.post_id = p.ID AND m.meta_key = '_wp_attachment_image_alt' WHERE p.post_type = 'attachment' AND p.post_mime_type LIKE 'image/%' AND (m.meta_value IS NULL OR m.meta_value = '')"` },
  { title: "Set alt when rendering attachments in PHP", language: "php", code: "echo wp_get_attachment_image( $attachment_id, 'large', false, array( 'alt' => 'Describe the image' ) );" }
];

const JSONLD: Fix[] = [{
  title: "Output valid JSON-LD (build an array, then encode — never concatenate strings)",
  language: "php",
  code: `add_action( 'wp_head', function () {
	$data = array(
		'@context' => 'https://schema.org',
		'@type'    => 'Organization',
		'name'     => get_bloginfo( 'name' ),
		'url'      => home_url( '/' ),
	);
	echo '<script type="application/ld+json">' . wp_json_encode( $data, JSON_UNESCAPED_SLASHES ) . '</script>';
} );`,
  note: "Check for duplicates first: SEO plugins already output an Organization/WebSite graph."
}];

const WEBP: Fix[] = [
  { title: "Generate WebP for new uploads (WordPress 6.5+)", language: "php", code: `add_filter( 'image_editor_output_format', function ( $formats ) {
	$formats['image/jpeg'] = 'image/webp';
	$formats['image/png']  = 'image/webp';
	return $formats;
} );`, note: "Then regenerate existing sizes (below). Keep the originals; test on staging first." },
  { title: "Regenerate thumbnails (rebuilds EVERY image size on the site: run it off-peak, or use the exact-attachment command under Images)", language: "bash", code: "wp media regenerate --yes" }
];

const OPTIMIZE: Fix[] = [{
  title: "Compress generated image sizes (lossy quality 80–82 is usually visually identical)",
  language: "php",
  code: `add_filter( 'wp_editor_set_quality', function () {
	return 82;
} );`,
  note: "Applies to newly generated sizes. Run `wp media regenerate --yes` to rebuild existing ones, and compare a few images visually first."
}];

const RESPONSIVE: Fix[] = [{
  title: "Serve correctly sized images with srcset/sizes (WordPress does this when you use its image functions)",
  language: "php",
  code: `add_image_size( 'hero-wide', 1600, 800, true );
echo wp_get_attachment_image( $id, 'hero-wide', false, array( 'sizes' => '(max-width: 800px) 100vw, 1600px' ) );`
}];

const LCP: Fix[] = [{
  title: "Prioritise the LCP image (and never lazy-load it)",
  language: "php",
  code: `echo wp_get_attachment_image( $hero_id, 'hero-wide', false, array(
	'fetchpriority' => 'high',
	'loading'       => 'eager',
) );`,
  note: "Measured: the LCP element is reported in the performance section. Fixing it only helps if that element is the cause on your pages."
}];

const SERVER: Fix[] = [
  { title: "Find slow queries and hooks", language: "bash", code: "wp package install wp-cli/profile-command\nwp profile stage --url=https://example.com/ --spotlight" },
  { title: "Enable full-page caching (host cache or a caching plugin) and an object cache", language: "php", code: "// wp-config.php\ndefine( 'WP_CACHE', true );", note: "Pick one page-cache solution; confirm with response headers (cache-control / x-cache)." }
];

const RENDER_BLOCKING: Fix[] = [{
  title: "Load non-critical scripts with defer (WordPress 6.3+)",
  language: "php",
  code: "wp_enqueue_script( 'YOUR-HANDLE', get_theme_file_uri( 'YOUR-SCRIPT.js' ), array(), '1.0', array( 'strategy' => 'defer', 'in_footer' => true ) );"
}];

const COMPRESSION: Fix[] = [
  { title: "Enable gzip/brotli (nginx)", language: "nginx", code: "gzip on;\ngzip_types text/css application/javascript text/javascript application/json image/svg+xml;" },
  { title: "Enable compression (Apache)", language: "apache", code: "<IfModule mod_deflate.c>\n  AddOutputFilterByType DEFLATE text/html text/css application/javascript text/javascript application/json image/svg+xml\n</IfModule>" }
];

const CACHE: Fix[] = [{ title: "Long cache lifetime for static assets (Apache)", language: "apache", code: '<IfModule mod_expires.c>\n  ExpiresActive On\n  ExpiresByType image/webp "access plus 1 year"\n  ExpiresByType text/css "access plus 1 year"\n  ExpiresByType application/javascript "access plus 1 year"\n  ExpiresByType text/javascript "access plus 1 year"\n</IfModule>' }];

const LAZY: Fix[] = [{ title: "Lazy-load below-the-fold images", language: "html", code: '<img src="photo.webp" alt="..." width="800" height="600" loading="lazy" decoding="async">' }];

const BY_RULE: Record<string, Fix[]> = {
  "seo.canonical.missing": CANONICAL, "seo.robots.noindex": NOINDEX, "seo.description.missing": DESCRIPTION,
  "seo.title.missing": TITLE, "seo.h1.missing": H1, "seo.h1.multiple": H1, "a11y.images.missing-alt": ALT,
  "schema.jsonld.invalid-json": JSONLD,
  // Lighthouse audit ids
  "modern-image-formats": WEBP, "uses-webp-images": WEBP, "uses-responsive-images": RESPONSIVE, "uses-optimized-images": OPTIMIZE, "offscreen-images": LAZY,
  "server-response-time": SERVER, "render-blocking-resources": RENDER_BLOCKING, "uses-text-compression": COMPRESSION,
  "uses-long-cache-ttl": CACHE, "lcp-image": LCP
};

const BY_DIFF_TITLE: Record<string, string> = {
  "Canonical URL changed": "seo.canonical.missing", "Robots directive changed": "seo.robots.noindex", "Meta description changed": "seo.description.missing",
  "Page title changed": "seo.title.missing", "H1 content changed": "seo.h1.missing", "More images lack alt text": "a11y.images.missing-alt",
  "Structured data types changed": "schema.jsonld.invalid-json", "JSON-LD block count decreased": "schema.jsonld.invalid-json", "HTTP status changed": "http.redirect"
};

/** Rule ids that have catalogue fixes (used by tests to check every one). */
export const catalogRuleIds = (): string[] => [...Object.keys(BY_RULE), "http.redirect", "http.error-status"];

export interface FixContext { pageUrl?: string; redirectTo?: string }

const esc_re = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Redirect rules for one URL. With a known source and target they are exact; otherwise the unknown part is an obvious CAPITALISED
 * placeholder, never a plausible-looking fake value. Rules that could loop are never produced: if the path and query are unchanged
 * (http -> https, www -> non-www) the redirect has to happen at the domain level, and an identical source and target needs no rule.
 */
export function redirectFixes(from?: string, to?: string, only404 = false): Fix[] {
  const parse = (u?: string) => { try { return u && safeUrl(u) ? new URL(u) : undefined; } catch { return undefined; } };
  const f = parse(from), t = parse(to);
  if (f && t && f.origin === t.origin && f.pathname === t.pathname && f.search === t.search) return [];
  const targetUrl = t ? `${t.origin}${t.pathname}${t.search}` : "https://YOUR-SITE/NEW-PATH/";

  // Same path and query on another scheme/host: a path rule would send the new URL to itself forever.
  if (f && t && f.pathname === t.pathname && f.search === t.search) {
    const note = "The path does not change, so a path-based rule would redirect the new URL to itself in an endless loop. This redirects at the domain level instead.";
    if (f.hostname === t.hostname && f.protocol === "http:" && t.protocol === "https:") return [
      { title: "Redirect HTTP to HTTPS (Apache .htaccess)", language: "apache", code: `RewriteEngine On\nRewriteCond %{HTTPS} off\nRewriteRule ^ https://${t.host}%{REQUEST_URI} [L,R=301]`, note },
      { title: "Redirect HTTP to HTTPS (nginx)", language: "nginx", code: `server {\n    listen 80;\n    server_name ${f.hostname};\n    return 301 "https://${t.host}$request_uri";\n}`, note }
    ];
    return [
      { title: `Redirect ${f.host} to ${t.host} (Apache .htaccess)`, language: "apache", code: `RewriteEngine On\nRewriteCond %{HTTP_HOST} ^${esc_re(f.host)}$ [NC]\nRewriteRule ^ ${t.protocol}//${t.host}%{REQUEST_URI} [L,R=301]`, note },
      { title: `Redirect ${f.host} to ${t.host} (nginx)`, language: "nginx", code: `server {\n    server_name ${f.hostname};\n    return 301 "${t.protocol}//${t.host}$request_uri";\n}`, note }
    ];
  }

  const path = f && /^\/[A-Za-z0-9._~/%-]*$/.test(f.pathname) ? f.pathname : "/OLD-PATH/";
  const query = f ? f.search.replace(/^\?/, "") : "";
  const exact = !!f && !!t && path !== "/OLD-PATH/";
  const sameHost = !!f && !!t && f.hostname === t.hostname;
  const note = exact ? "Exact rule for this URL. Use only one of these (server config or WordPress code), not both." : "Replace the CAPITALISED parts: OLD-PATH is the path of the URL being redirected, NEW-PATH the page that replaces it.";
  const q = esc_re(query);
  return [
    { title: "301 redirect to the final URL (Apache .htaccess)", language: "apache",
      code: query ? `RewriteEngine On\nRewriteCond %{QUERY_STRING} ^${q}$\nRewriteRule ^${esc_re(path.replace(/^\//, ""))}$ ${targetUrl} [L,R=301]` : `RedirectMatch 301 ^${esc_re(path)}$ ${targetUrl}`, note },
    { title: "301 redirect to the final URL (nginx)", language: "nginx",
      code: query ? `location = ${path} {\n    if ($args = "${query}") {\n        return 301 "${targetUrl}";\n    }\n}` : `location = ${path} { return 301 "${targetUrl}"; }`, note },
    {
      title: "301 redirect in WordPress code", language: "php",
      code: `add_action( 'template_redirect', function () {
	$uri  = isset( $_SERVER['REQUEST_URI'] ) ? wp_unslash( $_SERVER['REQUEST_URI'] ) : '';
	$path = wp_parse_url( $uri, PHP_URL_PATH );${query ? "\n\t$query = (string) wp_parse_url( $uri, PHP_URL_QUERY );" : ""}
	if ( ${only404 ? "is_404() && " : ""}${php(path)} === $path${query ? ` && ${php(query)} === $query` : ""} ) {
		${sameHost || !exact ? "wp_safe_redirect" : "wp_redirect"}( ${php(targetUrl)}, 301 );
		exit;
	}
} );`,
      note: note + (sameHost || !exact ? "" : " The target is on another host, so wp_redirect() is used (wp_safe_redirect() refuses other hosts).")
    }
  ];
}

const withUrl = (list: Fix[], pageUrl?: string): Fix[] => {
  const url = pageUrl && safeUrl(pageUrl) ? pageUrl : "https://YOUR-SITE/";
  return list.map((f) => ({ ...f, code: f.code.replaceAll("https://example.com/", url) }));
};

/** Generic, copy-and-adapt examples. They are suggestions, not verified fixes for the audited site. */
export function fixesForRule(ruleId: string, ctx: FixContext = {}): Fix[] {
  if (ruleId === "http.redirect") return redirectFixes(ctx.pageUrl, ctx.redirectTo);
  if (ruleId === "http.error-status") return redirectFixes(ctx.pageUrl, undefined, true);
  return withUrl(BY_RULE[ruleId] ?? [], ctx.pageUrl);
}
/**
 * Advice for one old-vs-new difference. It depends on the DIRECTION of the change: a robots change that removed noindex, or a
 * description that was added, needs no fix. With no values to judge (older data), no advice is offered rather than a guess.
 */
export function fixesForDifference(title: string, ctx: { oldUrl?: string; newUrl?: string; oldValue?: unknown; newValue?: unknown } = {}): Fix[] {
  const nv = ctx.newValue, ov = ctx.oldValue;
  if (nv === undefined && ov === undefined) return [];   // nothing to judge the direction by
  const empty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
  const forNew = (rule: string) => fixesForRule(rule, { pageUrl: ctx.newUrl });
  switch (title) {
    case "Robots directive changed": return isNoindex(typeof nv === "string" ? nv : null) && !isNoindex(typeof ov === "string" ? ov : null) ? forNew("seo.robots.noindex") : [];
    case "Canonical URL changed": return empty(nv) ? forNew("seo.canonical.missing") : [];
    case "Meta description changed": return empty(nv) ? forNew("seo.description.missing") : [];
    case "Page title changed": return empty(nv) ? forNew("seo.title.missing") : [];
    case "H1 content changed": return Array.isArray(nv) && nv.length === 0 ? forNew("seo.h1.missing") : Array.isArray(nv) && nv.length > 1 ? forNew("seo.h1.multiple") : [];
    case "More images lack alt text": return forNew("a11y.images.missing-alt");
    case "Structured data types changed": return Array.isArray(ov) && Array.isArray(nv) && ov.some((t) => !nv.includes(t)) ? forNew("schema.jsonld.invalid-json") : [];
    case "JSON-LD block count decreased": return forNew("schema.jsonld.invalid-json");
    case "HTTP status changed": return typeof nv === "number" && nv >= 400 ? redirectFixes(ctx.newUrl, undefined, true) : [];
    default: return [];   // e.g. "Internal link count decreased": a content review, not code
  }
}
