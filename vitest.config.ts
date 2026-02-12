import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Local worktrees and build outputs must not be picked up as test roots.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-server/**",
      "**/.tmp/**",
    ],
  },
})

