import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**"],
      exclude: [
        "src/**/*.test.ts",
        "src/types/**",
        "src/local.ts",
        // Schema files are zod definitions; testing them tests zod itself.
        "src/lib/schemas/**",
      ],
    },
  },
});
