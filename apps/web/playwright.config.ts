import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../../output/playwright/test-results",
  reporter: [
    ["html", { outputFolder: "../../output/playwright/report", open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chrome",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
  webServer: [
    {
      command:
        "UV_CACHE_DIR=.cache/uv CHATTY_E2E_DATABASE=.cache/browser-e2e.sqlite uv run uvicorn tests.browser_smoke_app:app --host 127.0.0.1 --port 8000",
      cwd: "../..",
      url: "http://127.0.0.1:8000/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "pnpm dev",
      url: "http://127.0.0.1:3000/playground",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
