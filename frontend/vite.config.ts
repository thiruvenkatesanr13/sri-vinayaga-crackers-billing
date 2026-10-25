import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Built files go into the Django project, which serves them on the shop PC.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../backend/frontend_dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/media": "http://127.0.0.1:8000",
    },
  },
  test: {
    environment: "node",
  },
});
