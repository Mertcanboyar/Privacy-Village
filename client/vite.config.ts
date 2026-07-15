import { defineConfig } from "vite";
import { resolve } from "path";

// Two entry points: the game (index.html) and the /ui-kit.html component
// catalog (client/src/ui-kit.ts) — dev server serves both with zero config,
// but `vite build` needs each html file listed here to emit both bundles.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        uiKit: resolve(__dirname, "ui-kit.html"),
      },
    },
  },
});
