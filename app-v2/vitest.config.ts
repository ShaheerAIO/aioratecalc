import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Vitest doesn't read tsconfig `paths`, so the app's "@/..." alias has to be
// restated here for tests that import modules by their normal app path.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // tsconfig.json sets "jsx": "preserve" (Next.js does its own JSX transform
  // at build time), which isn't one of esbuild's own modes — without this,
  // esbuild falls back to the classic transform and any .tsx test that
  // renders a component fails with "React is not defined".
  esbuild: {
    jsx: "automatic",
  },
});
