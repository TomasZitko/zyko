import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://localhost:4000", "/hooks": "http://localhost:4000" },
  },
  build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 400 },
});
