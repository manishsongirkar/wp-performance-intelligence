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
  { title: "Decorative image: use an empty alt on purpose", language: "html", code: '<img src="/decor.svg" alt="" width="40" height="40">', note: "An empty alt is valid for decorative images; this tool currently counts it as missing, so review before changing." },
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

const REDIRECT: Fix[] = [
  { title: "Single 301 to the final URL (Apache .htaccess)", language: "apache", code: "Redirect 301 /old-page/ https://www.example.com/new-page/" },
  { title: "Single 301 to the final URL (nginx)", language: "nginx", code: "location = /old-page/ { return 301 https://www.example.com/new-page/; }" },
  { title: "Redirect in WordPress code", language: "php", code: "add_action( 'template_redirect', function () {\n\tif ( is_404() && '/old-page/' === wp_parse_url( $_SERVER['REQUEST_URI'], PHP_URL_PATH ) ) {\n\t\twp_safe_redirect( home_url( '/new-page/' ), 301 );\n\t\texit;\n\t}\n} );" }
];

const WEBP: Fix[] = [
  { title: "Generate WebP for new uploads (WordPress 6.5+)", language: "php", code: `add_filter( 'image_editor_output_format', function ( $formats ) {
	$formats['image/jpeg'] = 'image/webp';
	$formats['image/png']  = 'image/webp';
	return $formats;
} );`, note: "Then regenerate existing sizes (below). Keep the originals; test on staging first." },
  { title: "Regenerate thumbnails", language: "bash", code: "wp media regenerate --yes" }
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
  code: "wp_enqueue_script( 'my-script', get_theme_file_uri( 'app.js' ), array(), '1.0', array( 'strategy' => 'defer', 'in_footer' => true ) );"
}];

const COMPRESSION: Fix[] = [
  { title: "Enable gzip/brotli (nginx)", language: "nginx", code: "gzip on;\ngzip_types text/css application/javascript application/json image/svg+xml;" },
  { title: "Enable compression (Apache)", language: "apache", code: "<IfModule mod_deflate.c>\n  AddOutputFilterByType DEFLATE text/html text/css application/javascript application/json image/svg+xml\n</IfModule>" }
];

const CACHE: Fix[] = [{ title: "Long cache lifetime for static assets (Apache)", language: "apache", code: '<IfModule mod_expires.c>\n  ExpiresActive On\n  ExpiresByType image/webp "access plus 1 year"\n  ExpiresByType text/css "access plus 1 year"\n  ExpiresByType application/javascript "access plus 1 year"\n</IfModule>' }];

const LAZY: Fix[] = [{ title: "Lazy-load below-the-fold images", language: "html", code: '<img src="photo.webp" alt="..." width="800" height="600" loading="lazy" decoding="async">' }];

const BY_RULE: Record<string, Fix[]> = {
  "seo.canonical.missing": CANONICAL, "seo.robots.noindex": NOINDEX, "seo.description.missing": DESCRIPTION,
  "seo.title.missing": TITLE, "seo.h1.missing": H1, "seo.h1.multiple": H1, "a11y.images.missing-alt": ALT,
  "schema.jsonld.invalid-json": JSONLD, "http.redirect": REDIRECT, "http.error-status": REDIRECT,
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

/** Generic, copy-and-adapt examples. They are suggestions, not verified fixes for the audited site. */
export const fixesForRule = (ruleId: string): Fix[] => BY_RULE[ruleId] ?? [];
export const fixesForDifference = (title: string): Fix[] => fixesForRule(BY_DIFF_TITLE[title] ?? "");
