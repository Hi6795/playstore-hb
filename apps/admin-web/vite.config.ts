import { defineConfig } from "vite"; import { resolve } from "node:path";
export default defineConfig({ root: resolve(import.meta.dirname), base: "./", server: { port: 5174 }, build: { outDir: resolve(import.meta.dirname, "../../dist/admin-web"), emptyOutDir: true } });
