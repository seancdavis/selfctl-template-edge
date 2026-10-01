import { defineConfig } from "vitest/config";

// Unit tests only. This is its own config rather than a `test` block in
// vite.config.ts: the app's build plugins (TanStack Start, Netlify) have
// nothing to do with a test run. `passWithNoTests` lets the suite start empty
// and keeps CI green until the first `*.test.ts` lands next to the code it
// covers.
export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", ".netlify/**"],
    passWithNoTests: true,
  },
});
