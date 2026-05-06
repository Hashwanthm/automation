// Vite development configuration.
// API paths are proxied to the Express backend so frontend code can call
// relative URLs in both development and production builds.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/upload": { target: apiTarget, changeOrigin: true },
      "/start": { target: apiTarget, changeOrigin: true },
      "/stop": { target: apiTarget, changeOrigin: true },
      "/pause": { target: apiTarget, changeOrigin: true },
      "/resume": { target: apiTarget, changeOrigin: true },
      "/status": { target: apiTarget, changeOrigin: true },
      "/logs": { target: apiTarget, changeOrigin: true },
      "/clients": { target: apiTarget, changeOrigin: true },
      "/client-config": { target: apiTarget, changeOrigin: true },
      "/db": { target: apiTarget, changeOrigin: true },
      "/retry": { target: apiTarget, changeOrigin: true },
      "/history": { target: apiTarget, changeOrigin: true },
      "/settings": { target: apiTarget, changeOrigin: true },
      "/network": { target: apiTarget, changeOrigin: true },
      "/backups": { target: apiTarget, changeOrigin: true },
      "/audit": { target: apiTarget, changeOrigin: true },
      "/queue": { target: apiTarget, changeOrigin: true }
    }
  }
});
