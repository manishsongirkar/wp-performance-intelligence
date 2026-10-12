import { auditPage } from "../../../packages/audit-core/src/audit.js";
import { parseUrlCsv } from "../../../packages/url-import/src/csv.js";
import { loadConfig, loadDotEnv } from "./config.js";
import { readFile, writeFile } from "node:fs/promises";

async function main() {
  const [, , command, arg1, arg2] = process.argv;
  if (command === "audit" && arg1) {
    loadDotEnv();
    const result = await auditPage(arg1, loadConfig().fetch);
    const output = arg2 ?? "wpi-audit.json";
    await writeFile(output, JSON.stringify(result, null, 2));
    console.log(`Audited ${arg1}; ${result.findings.length} findings written to ${output}`);
    return;
  }
  if (command === "csv" && arg1) {
    const parsed = parseUrlCsv(await readFile(arg1, "utf8"));
    console.log(JSON.stringify(parsed, null, 2));
    return;
  }
  console.log("Usage:\n  pnpm audit audit <url> [output.json]\n  pnpm audit csv <file.csv>");
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
