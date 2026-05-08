import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      include: ["src/**"],
      exclude: ["src/**/*.test.ts", "src/local.ts", "src/service.ts"],
    },
  },
});
