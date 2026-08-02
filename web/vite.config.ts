import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Dev: `bun run dev` serves the UI and proxies /api to the workflow server that
 * runs inside the omp process (or spike/web-standalone.ts).
 * Build: emits a relative-path bundle into web/dist, which src/web-server.ts
 * serves directly — no node process in production.
 */
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: {
    port: 5178,
    proxy: {
      "/api": {
        target: process.env.WF_API ?? "http://127.0.0.1:7788",
        changeOrigin: true,
      },
    },
  },
});
