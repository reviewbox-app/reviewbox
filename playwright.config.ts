import { defineConfig } from "@playwright/test"
export default defineConfig({
  testDir: "tests/web",
  outputDir: "artifacts/playwright",
  use: {
    baseURL: "http://127.0.0.1:1420",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "bun run dev:web",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !process.env.CI,
  },
})
