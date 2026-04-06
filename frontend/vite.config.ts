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
