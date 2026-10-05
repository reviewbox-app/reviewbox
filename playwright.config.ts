import { defineConfig } from "@playwright/test"
export default defineConfig({
  workers: process.env.CI ? 1 : undefined,
  timeout: 60000,
  expect: { timeout: 15000 },
  testDir: "tests/web",
  outputDir: "artifacts/playwright",
  use: {
    baseURL: "http://127.0.0.1:1420",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    // Bun + Turbopack currently mis-resolves Shiki externals in the test server.
    command: "bun run dev:web --webpack",
    timeout: 120000,
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !process.env.CI,
  },
})
