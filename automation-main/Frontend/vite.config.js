// Vite development configuration.
// API paths are proxied to the Express backend so frontend code can call
// relative URLs in both development and production builds.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/upload": "http://localhost:3000",
      "/start": "http://localhost:3000",
      "/stop": "http://localhost:3000",
      "/status": "http://localhost:3000",
      "/logs": "http://localhost:3000",
      "/clients": "http://localhost:3000",
      "/db": "http://localhost:3000",
      "/retry": "http://localhost:3000"
    }
  }
});
