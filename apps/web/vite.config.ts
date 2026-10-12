import { defineConfig } from "vite";
const root = new URL(".", import.meta.url).pathname;
export default defineConfig({ root, build: { outDir: "dist", emptyOutDir: true }, server: { host: "127.0.0.1", port: 5173 } });
