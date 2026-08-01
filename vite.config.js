import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  publicDir: "frontend-public",
  build: {
    outDir: "public",
    // `public` is generated output. Start clean so stale bundles from earlier
    // prototypes are never shipped with the hackathon build.
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3456",
    },
  },
});
