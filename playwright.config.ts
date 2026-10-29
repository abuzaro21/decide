import { defineConfig, devices } from '@playwright/test';

// Browser tests drive the real server (real SQLite, real decisions) through the built UI.
// Set E2E_BASE_URL to run the same journey as a post-deploy smoke test against a live URL (no local server is started).
const live = process.env.E2E_BASE_URL;
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: { baseURL: live ?? 'http://127.0.0.1:3210', trace: 'retain-on-failure' },
  webServer: live ? undefined : {
    command: 'node --disable-warning=ExperimentalWarning src/main.ts',
    url: 'http://127.0.0.1:3210/api/health',
    env: { PORT: '3210', DECIDE_DB: 'data/e2e.db' },
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
});
