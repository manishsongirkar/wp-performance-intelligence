import { buildApp } from "./app.js";
import { loadConfig, loadDotEnv } from "./config.js";

loadDotEnv();
let config;
try { config = loadConfig(); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(1); }
const app = buildApp(config);
app.log.info({ mode: config.fetch.policy.mode, host: config.host }, "Starting");
app.listen({ host: config.host, port: config.port }).catch((error) => { app.log.error(error); process.exit(1); });
