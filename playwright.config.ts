import { defineConfig, devices } from '@playwright/test'

/*
 * ブラウザで実際に触るテスト。
 *
 * Vitest（node / jsdom）で確かめられないものだけを置く場所。
 * 具体的には「保存されて、リロードしても残る」「別の人の画面にも届く」
 * のように、Supabase と Realtime を通さないと意味が無いもの。
 *
 * ローカルの Supabase が要る。動いていなければ e2e/global-setup.ts が
 * 全部スキップにするので、npm test の邪魔はしない。
 *   supabase start
 * 手順は docs/SETUP.md にある。
 */

const BASE_URL = 'http://localhost:5173'

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',

  timeout: 45_000,
  expect: { timeout: 10_000 },

  // 同じ Supabase を触るので、並べて走らせない
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    // ボードの暦は Asia/Tokyo 固定。ブラウザ側も揃えておく
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
