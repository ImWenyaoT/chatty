import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  outputDir: '../output/playwright/test-results',
  reporter: [
    ['html', { outputFolder: '../output/playwright/report', open: 'never' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
  webServer: [
    {
      command:
        'UV_CACHE_DIR=.cache/uv CHATTY_E2E_DATABASE=.cache/browser-e2e.sqlite uv run uvicorn --factory chatty.browser_smoke:create_app --port 8100',
      cwd: '..',
      url: 'http://127.0.0.1:8100/api/chatty/health',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'CHATTY_API_TARGET=http://127.0.0.1:8100 pnpm dev --port 3100',
      url: 'http://127.0.0.1:3100/api/chatty/health',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})
