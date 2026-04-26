import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split les vendors lourds dans des chunks séparés : meilleur cache
        // navigateur (Recharts/Radix changent rarement) et chunk principal allégé.
        manualChunks(id) {
          if (id.includes("node_modules")) {
            // Recharts + d3 = ~290 KB, séparé pour ne pas peser sur les pages
            // qui n'affichent pas de graph (Containers, Settings, Audit…)
            if (id.includes("recharts") || id.includes("d3-")) return "recharts";
            if (id.includes("@radix-ui")) return "radix";
            if (id.includes("lucide-react")) return "icons";
            // React + react-router + autres libs vont ensemble dans vendor pour
            // éviter les imports circulaires. Reste cacheable séparément.
            return "vendor";
          }
        },
      },
    },
  },
  server: {
    port: 26032,
    proxy: {
      "/api": {
        target: "http://localhost:26031",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:26031",
        ws: true,
      },
    },
  },
});
