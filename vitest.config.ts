import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
  test: {
    globals: false,
    environment: "node",
    // Tests assume XFF headers are trustworthy (tests run off-platform).
    // The rate limiter's runtime trust check reads these env vars — without
    // the opt-in, XFF would be ignored and tests that set `x-forwarded-for`
    // to key buckets would collide on the "unknown" fallback.
    env: {
      TRUST_FORWARDED: "true",
    },
    include: ["tests/**/*.spec.ts"],
    exclude: ["tests/e2e/**", "node_modules/**", ".next/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["lib/**/*.ts", "app/**/route.ts"],
      exclude: [
        "lib/skills/**",
        "lib/utils.ts",
        "lib/engine/index.ts",
        "**/*.d.ts",
        "**/*.spec.ts",
      ],
      thresholds: {
        perFile: true,
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
