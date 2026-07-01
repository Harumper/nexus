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
        // Split heavy vendors into separate chunks: better browser
        // caching (Recharts/Radix rarely change) and a lighter main chunk.
        manualChunks(id) {
          if (id.includes("node_modules")) {
            // Recharts + d3 = ~290 KB, separated so it doesn't weigh on pages
            // that don't show a chart (Containers, Settings, Audit…)
            if (id.includes("recharts") || id.includes("d3-")) return "recharts";
            if (id.includes("@radix-ui")) return "radix";
            if (id.includes("lucide-react")) return "icons";
            // React + react-router + other libs go together in vendor to
            // avoid circular imports. Still cacheable separately.
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
