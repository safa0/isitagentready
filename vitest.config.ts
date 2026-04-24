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
    // Tests assume XFF headers are trustworthy (tests run off-platform).
    // The rate limiter's runtime trust check reads these env vars — without
    // the opt-in, XFF would be ignored and tests that set `x-forwarded-for`
    // to key buckets would collide on the "unknown" fallback.
    env: {
      TRUST_FORWARDED: "true",
    },
    // Split into projects so Node-side tests run under `node` and React
    // component tests run under `jsdom`. Keeps the existing 431 Node tests
    // unaffected while letting the new components/ tests use DOM APIs.
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.spec.ts"],
          exclude: ["tests/e2e/**", "node_modules/**", ".next/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "components",
          environment: "jsdom",
          include: ["tests/components/**/*.spec.tsx"],
          exclude: ["tests/e2e/**", "node_modules/**", ".next/**"],
          setupFiles: ["./tests/components/setup.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "lib/**/*.ts",
        "app/**/route.ts",
        "components/**/*.tsx",
      ],
      exclude: [
        "lib/skills/**",
        "lib/utils.ts",
        "lib/engine/index.ts",
        "components/ui/**",
        "**/*.d.ts",
        "**/*.spec.ts",
        "**/*.spec.tsx",
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
