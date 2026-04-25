import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY ?? "https://d3tavvh2o76dc5.cloudfront.net",
        changeOrigin: true,
        secure: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
