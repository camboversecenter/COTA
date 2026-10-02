import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

// The cloudflare() plugin runs the Worker in workerd during `vite dev` and builds
// it alongside the client on `vite build`. The wallet's signer is a module Web Worker.
export default defineConfig({
  plugins: [react(), cloudflare()],
  worker: { format: "es" },
  build: { target: "es2022" },
});
