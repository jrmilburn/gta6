import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './smoke',
  // Generous, because the specs that matter measure SIMULATED seconds, and the
  // software renderer CI runs on converts a 1 s simulated window into anything
  // from 1 s to a minute of wall time depending on what else the machine is
  // doing. The assertions are frame-rate independent; only the clock is not.
  timeout: 420_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    headless: true,
    viewport: { width: 1280, height: 720 },
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: 'http://localhost:4173',
    timeout: 180_000,
    reuseExistingServer: true,
  },
});
