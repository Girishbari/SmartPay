import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The console calls the Engine through /api so the browser never needs CORS. Engine routes stay un-prefixed.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:3000", rewrite: (p) => p.replace(/^\/api/, "") } },
  },
});
