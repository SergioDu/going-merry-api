import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Keep the structured logger quiet by default; logger tests opt back in to the
    // level they assert on.
    env: { LOG_LEVEL: "silent" },
  },
});
