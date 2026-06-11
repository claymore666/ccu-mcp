import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      // Count every source file, including ones no test imports
      include: ["src/**/*.ts"],
    },
  },
});
