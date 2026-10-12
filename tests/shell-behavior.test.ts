import http from "node:http";
import { chmodSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exactFixes, type ExactFixContext } from "../packages/reports/src/exact-fixes.js";

// These tests RUN the generated shell commands (real curl, real PurgeCSS, stand-ins for cwebp and wp) instead of only reading them.
const PAGE = `<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><div class="used card"><p class="lead">Hi</p></div></body></html>`;
const CSS = `.used{color:red}.card{padding:1px}.lead{margin:0}.unused-thing{color:blue}.other-page-only{display:none}.is-active{color:green}.menu-open .nav{display:block}@media (min-width:600px){.unused-wide{width:1px}}`;

let server: http.Server; let base: string; let work: string; let shims: string;
const env = () => ({ ...process.env, PATH: `${shims}:${resolve("node_modules/.bin")}:${process.env.PATH}` });
// Async on purpose: the test web server lives in this process, so a blocking spawn would deadlock curl.
const run = (code: string, extraEnv: Record<string, string> = {}) => new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
  const p = spawn("bash", ["-c", code], { cwd: work, env: { ...env(), ...extraEnv } });
  let stdout = "", stderr = ""; p.stdout.on("data", (d) => (stdout += d)); p.stderr.on("data", (d) => (stderr += d));
  const t = setTimeout(() => p.kill(), 90_000);
  p.on("close", (status) => { clearTimeout(t); done({ status, stdout, stderr }); });
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const send = (type: string, body: string | Buffer) => { res.writeHead(200, { "content-type": type }); res.end(body); };
    if (req.url === "/page") return send("text/html", PAGE);
    if (req.url?.startsWith("/style.css")) return send("text/css", CSS);
    if (req.url === "/img/a.png") return send("image/png", Buffer.from("PNG-A"));
    if (req.url === "/img/b.jpg?ver=3") return send("image/jpeg", Buffer.from("JPG-B"));
    res.writeHead(404); res.end("nope");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  work = await mkdtemp(join(tmpdir(), "wpi-shell-"));
  shims = await mkdtemp(join(tmpdir(), "wpi-shims-"));
  await writeFile(join(shims, "cwebp"), '#!/bin/sh\nout="";in=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -q) shift 2;; -quiet) shift;; *) in="$1"; shift;; esac; done\ncp "$in" "$out"\n');
  await writeFile(join(shims, "wp"), '#!/bin/sh\nif [ "$1" = eval ]; then printf "%s" "$WP_EVAL_OUT"; exit 0; fi\nif [ "$1" = media ]; then echo "REGEN: $*"; exit 0; fi\nexit 1\n');
  chmodSync(join(shims, "cwebp"), 0o755); chmodSync(join(shims, "wp"), 0o755);
});
afterAll(() => { server.closeAllConnections(); server.close(); });

const ctx = (): ExactFixContext => ({
  pageUrl: `${base}/page`, metrics: {}, viewportWidth: 412,
  evidence: {
    "unused-css-rules": [{ url: `${base}/style.css?ver=1`, totalBytes: 400, wastedBytes: 200 }],
    "modern-image-formats": [
      { url: `${base}/img/a.png`, totalBytes: 900000, wastedBytes: 700000 }, { url: `${base}/img/b.jpg?ver=3`, totalBytes: 500000, wastedBytes: 300000 },
      { url: `${base}/img/missing.png`, totalBytes: 400000, wastedBytes: 200000 }, { url: `${base}/img/already.webp`, totalBytes: 300000, wastedBytes: 100000 }
    ]
  }
});
const fixOf = (area: RegExp, title: RegExp) => exactFixes(ctx()).find((g) => area.test(g.area))!.fixes.find((f) => title.test(f.title))!;

describe("PurgeCSS command", () => {
  it("works from any folder with no local WordPress files, and lists what it would remove", async () => {
    const r = await run(fixOf(/^Unused CSS/, /purge a COPY/).code);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const dir = /Reduced copies are in: (.+)$/m.exec(r.stdout)![1]!;
    const before = statSync(join(dir, "..", "css1.css")).size, after = statSync(join(dir, "css1.css")).size;
    expect(after).toBeLessThan(before);
    const purged = readFileSync(join(dir, "css1.css"), "utf8");
    expect(purged).toContain(".used"); expect(purged).toContain(".is-active");          // used + safelisted state class kept
    expect(purged).not.toContain("unused-thing"); expect(purged).not.toContain("other-page-only");
    const removed = readFileSync(join(dir, "..", "removed-css1.css.txt"), "utf8").split("\n");
    // Exactly the class selectors that are unused: nothing else (no CSS words such as "color"), nothing used or safelisted.
    expect(removed.filter(Boolean)).toEqual([".menu-open", ".nav", ".other-page-only", ".unused-thing", ".unused-wide"]);
    expect(r.stdout).toContain("Classes that would be removed: 5"); expect(r.stdout).toMatch(/Size:\s+\d+ KB -> \d+ KB/); expect(r.stdout).toContain("   .unused-thing");
      });
  it("fails loudly (not silently) when the stylesheet cannot be downloaded", async () => {
    const c = ctx(); c.evidence["unused-css-rules"] = [{ url: `${base}/missing.css`, totalBytes: 400, wastedBytes: 200 }];
    const code = exactFixes(c).find((g) => /^Unused CSS/.test(g.area))!.fixes[0]!.code;
    const r = await run(code);
    expect(r.status).not.toBe(0); expect(r.stderr).toMatch(/404|error/i);
  });
});

describe("image conversion command", () => {
  it("downloads, converts, skips non-convertible formats, and keeps going after a failed download", async () => {
    const fx = fixOf(/^Images/, /Download and convert/);
    expect(fx.code).not.toContain("already.webp");                    // cwebp cannot read WebP: never listed
    const r = await run(fx.code);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const out = join(work, "webp-out");
    expect(readdirSync(out).sort()).toEqual(expect.arrayContaining(["a.png", "a.webp", "b.jpg", "b.webp"]));
    expect(readFileSync(join(out, "a.webp"), "utf8")).toBe("PNG-A");
    expect(r.stdout).toContain(`download failed: ${base}/img/missing.png`);
    expect(existsSync(join(out, "missing.webp"))).toBe(false);
  });
});

describe("regenerate command", () => {
  const code = () => fixOf(/^Images/, /Regenerate the WordPress sizes/).code;
  it("regenerates exactly the matched attachments", async () => {
    const r = await run(code(), { WP_EVAL_OUT: "12 34 " });
    expect(r.stdout.trim()).toBe("REGEN: media regenerate 12 34 --yes");
  });
  it("never regenerates the whole library when no attachment matches", async () => {
    for (const out of ["", "   "]) {
      const r = await run(code(), { WP_EVAL_OUT: out });
      expect(r.stdout).toContain("nothing to regenerate"); expect(r.stdout).not.toContain("REGEN");
    }
  });
  it("embeds valid PHP in wp eval", () => {
    const m = /wp eval '([^']+)'/.exec(code())!;
    if (spawnSync("php", ["-v"]).status !== 0) return;
    const r = spawnSync("php", ["-l"], { input: `<?php ${m[1]}`, encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});

// ---- the same commands, pasted into an INTERACTIVE zsh (the macOS default shell). A bare "# comment" line is an error there. ----
const hasZsh = spawnSync("zsh", ["--version"]).status === 0;
const runZsh = (code: string, extraEnv: Record<string, string> = {}) => new Promise<{ stdout: string; stderr: string }>((done) => {
  const p = spawn("zsh", ["-f", "-i"], { cwd: work, env: { ...env(), ...extraEnv, PS1: "" } });
  let stdout = "", stderr = ""; p.stdout.on("data", (d) => (stdout += d)); p.stderr.on("data", (d) => (stderr += d));
  const t = setTimeout(() => p.kill(), 90_000);
  p.on("close", () => { clearTimeout(t); done({ stdout, stderr }); });
  p.stdin.end(`${code}\necho __TERMINAL_STILL_ALIVE__\nexit\n`);
});

describe.skipIf(!hasZsh)("pasted into interactive zsh", () => {
  it("every multi-line shell command is wrapped in bash (a bare # comment is 'command not found' in interactive zsh)", () => {
    const fixes = exactFixes(ctx()).flatMap((g) => g.fixes).filter((f) => f.language === "bash" && f.code.includes("\n") && !f.code.startsWith("wp eval"));
    expect(fixes.length).toBeGreaterThan(2);
    for (const f of fixes) expect(f.code, f.title).toMatch(/^bash <<'WPI'\n[\s\S]*\nWPI$/);
  });
  it("PurgeCSS command works, leaves no zsh errors, and `set -e` cannot close the terminal", async () => {
    const ok = await runZsh(fixOf(/^Unused CSS/, /purge a COPY/).code);
    expect(ok.stderr).not.toMatch(/command not found|parse error|bad (pattern|substitution)/i);
    expect(ok.stdout).toMatch(/Reduced copies are in: /); expect(ok.stdout).toContain("Classes that would be removed"); expect(ok.stdout).toContain("__TERMINAL_STILL_ALIVE__");
    const c = ctx(); c.evidence["unused-css-rules"] = [{ url: `${base}/missing.css`, totalBytes: 400, wastedBytes: 200 }];
    const failing = await runZsh(exactFixes(c).find((g) => /^Unused CSS/.test(g.area))!.fixes[0]!.code);
    expect(failing.stdout).toContain("__TERMINAL_STILL_ALIVE__");                            // the failure ended only the inner bash
  });
  it("image conversion command works", async () => {
    const r = await runZsh(fixOf(/^Images/, /Download and convert/).code);
    expect(r.stderr).not.toMatch(/command not found|parse error|bad (pattern|substitution)/i);
    expect(readFileSync(join(work, "webp-out", "a.webp"), "utf8")).toBe("PNG-A"); expect(r.stdout).toContain("download failed"); expect(r.stdout).toContain("__TERMINAL_STILL_ALIVE__");
  });
  it("regenerate command passes each ID as its own argument (zsh does not word-split $IDS) and never regenerates everything", async () => {
    const code = fixOf(/^Images/, /Regenerate the WordPress sizes/).code;
    expect((await runZsh(code, { WP_EVAL_OUT: "12 34 " })).stdout).toContain("REGEN: media regenerate 12 34 --yes");
    const none = await runZsh(code, { WP_EVAL_OUT: "" });
    expect(none.stdout).toContain("nothing to regenerate"); expect(none.stdout).not.toContain("REGEN");
  });
});
