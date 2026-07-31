import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      // Count every source file, including ones no test imports
      include: ["src/**/*.ts"],
      // Floor, set just under the numbers at the time of writing so ordinary
      // work doesn't trip it but a real slide does. Hermetic — a pure function
      // of the commit under test, so it stays inside the `build-and-test`
      // contract described in ci.yml.
      //
      // GLOBAL only, deliberately: src/index.ts reads as 0% because the e2e
      // suites spawn it as a subprocess and v8 coverage cannot attribute those.
      // A per-file threshold would fail on it permanently, for a measurement
      // artifact rather than a real gap.
      thresholds: {
        statements: 85,
        branches: 79,
        functions: 87,
        lines: 85,
      },
    },
  },
});
