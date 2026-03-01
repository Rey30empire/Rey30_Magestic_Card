import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  root: resolve(__dirname),
  base: command === "build" ? "/reycad/" : "/",
  plugins: [react()],
  server: {
    port: 4173,
    host: "127.0.0.1"
  },
  build: {
    outDir: resolve(__dirname, "..", "public", "reycad"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("@react-three") || id.includes("/three/")) {
              return "vendor-three";
            }
            if (id.includes("/react/") || id.includes("react-dom")) {
              return "vendor-react";
            }
            if (id.includes("dockview")) {
              return "vendor-dockview";
            }
            if (id.includes("idb-keyval") || id.includes("zustand") || id.includes("immer")) {
              return "vendor-state";
            }
          }
          return undefined;
        }
      }
    }
  }
}));
