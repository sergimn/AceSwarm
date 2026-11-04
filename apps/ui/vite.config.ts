import { defineConfig } from "vite";

// The controller serves the built UI, so the output goes into its `public/` directory. During
// development, `npm run dev` proxies the API and HLS requests to a controller on port 8080.
export default defineConfig({
  build: {
    outDir: "../controller/public",
    emptyOutDir: true,
    // Keep the ~250 flag images as separate files: the browser only fetches the few it shows.
    assetsInlineLimit: 0,
    // Android TV browsers and WebViews can lag behind; keep the syntax they understand.
    target: ["chrome89", "firefox91", "safari15"],
  },
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/hls": "http://localhost:8080",
    },
  },
});
