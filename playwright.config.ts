import { defineConfig } from "@playwright/test"
export default defineConfig({
  workers: process.env.CI ? 1 : undefined,
  timeout: 60000,
  expect: { timeout: 15000 },
  testDir: "tests/web",
  outputDir: "artifacts/playwright",
  use: {
    baseURL: "http://127.0.0.1:1423",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    // Export fixtures once: no HMR resets, cold route compilation or dev memory restarts.
    command:
      "REVIEWBOX_DEVTOOLS=1 bun run build:web && bun scripts/serve-web-tests.ts",
    timeout: 180000,
    url: "http://127.0.0.1:1423",
    reuseExistingServer: false,
  },
})
