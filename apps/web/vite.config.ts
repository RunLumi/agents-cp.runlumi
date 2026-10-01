import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    forwardConsole: {
      unhandledErrors: true,
      logLevels: ["warn", "error"],
    },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  // `preview` had no proxy, so `pnpm --filter @runlumi/agents-cp-web preview` served the PRODUCTION
  // build with every `/api` call unanswered -- the app could only ever reach its own server-error
  // state, and the production bundle could not be exercised locally at all.
  //
  // That matters beyond convenience. The repository's budgets are stated under "Web production
  // baseline", so the only faithful way to measure LCP and the long-task budget is against the built
  // artefact. The dev server transforms on demand, ships unminified modules, and holds an HMR client
  // and websocket open, so its timings are not the production timings: grading them against a
  // production budget is a false finding, and a warm dev number is a flattering fiction.
  preview: {
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "es2022",
  },
});
