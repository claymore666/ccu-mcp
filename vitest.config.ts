import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      // Count every source file, including ones no test imports
      include: ["src/**/*.ts"],
      // `text` is vitest's default and the one a human reads; `json-summary`
      // writes coverage/coverage-summary.json, which scripts/coverage-ratchet.mjs
      // parses for the per-directory floors in .github/coverage-baseline.txt.
      // Naming reporters replaces the defaults, so `text` has to be restated.
      reporter: ["text", "json-summary"],
      // Floor, set just under the numbers at the time of writing so ordinary
      // work doesn't trip it but a real slide does. Hermetic — a pure function
      // of the commit under test, so it stays inside the `build-and-test`
      // contract described in ci.yml.
      //
      // GLOBAL only, deliberately: src/index.ts reads as 0% because the e2e
      // suites spawn it as a subprocess and v8 coverage cannot attribute those.
      // A per-file threshold would fail on it permanently, for a measurement
      // artifact rather than a real gap.
      //
      // These numbers alone are not enough, because an average hides local
      // collapse. Deleting the src/http tests takes that directory from 100%
      // to 0%, and the global statement figure moves 86.05% -> 85.79% — a
      // quarter of a point, still clear of the 85% floor, so `npm test` passes
      // and nothing reports the loss. The per-directory floors in
      // .github/coverage-baseline.txt cover that gap; src/index.ts is exempted
      // there for the reason above.
      thresholds: {
        statements: 85,
        branches: 79,
        functions: 87,
        lines: 85,
      },
    },
  },
});
