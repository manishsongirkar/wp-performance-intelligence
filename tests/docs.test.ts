import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Documentation drifted from the code more than once. These checks fail when a documented setting or flag stops existing.
const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const docs = ["README.md", "docs/API.md", ".env.example"].map((f) => [f, read(f)] as const);

describe("documentation matches the code", () => {
  const config = read("apps/api/src/config.ts"), cli = read("apps/api/src/report-cli.ts"), app = read("apps/api/src/app.ts"), pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; engines: { node: string } };

  it("every WPI_* variable mentioned in the docs is read by the config", () => {
    for (const [file, text] of docs) for (const name of new Set(text.match(/\bWPI_[A-Z_]+\b/g) ?? [])) expect(config, `${file} mentions ${name}`).toContain(name);
  });
  it("every WPI_* variable the config reads is documented in the README table", () => {
    const readme = read("README.md");
    for (const name of new Set(config.match(/\bWPI_[A-Z_]+\b/g) ?? [])) expect(readme, `${name} is undocumented`).toContain(name);
  });
  it("every --flag the README shows for `wpi report` exists in the CLI", () => {
    const section = read("README.md").split("## HTML reports")[1]!.split("## Configuration")[0]!;
    for (const flag of new Set(section.match(/(?<![\w-])--[a-z]+(?:-[a-z]+)*/g) ?? [])) {
      if (["--runs", "--profile", "--audit", "--compare", "--measure", "--lighthouse", "--baseline", "--out"].includes(flag)) expect(cli, flag).toContain(`${flag.slice(2)}:`);
    }
  });
  it("documented npm/pnpm scripts exist", () => {
    for (const script of ["ui", "dev", "dev:web", "wpi", "test", "build", "typecheck"]) expect(pkg.scripts[script], script).toBeTruthy();
    expect(pkg.scripts.audit).toBeUndefined();            // "pnpm audit" is a built-in pnpm command: the script is called wpi
  });
  it("every documented API route exists, and the documented Node version matches package.json", () => {
    const api = read("docs/API.md");
    for (const route of ["/health", "/api/audit", "/api/compare", "/api/measure", "/api/lighthouse", "/api/import/csv", "/api/export/xlsx", "/api/jobs", "/api/history", "/api/reports"]) { expect(api, route).toContain(route); expect(app, route).toContain(`"${route}`); }
    expect(read("README.md")).toContain(pkg.engines.node.replace(">=", "") + " or newer");
  });
  it("the removed PageSpeed Insights API integration is not documented as a feature", () => {
    for (const [file, text] of docs) expect(text, file).not.toMatch(/--psi|WPI_PSI/);
  });
});
