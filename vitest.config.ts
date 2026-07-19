import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "apps/**/*.test.ts"],
    coverage: { reporter: ["text", "json-summary"] },
    testTimeout: 15_000
  }
});
