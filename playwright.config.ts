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
 *   npm run db:start
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

  /*
   * Chromium だけが全部を走る。Firefox と WebKit は @smoke を付けたものだけ。
   *
   * 全部を 3 つのブラウザで回すと、workers: 1 なので単純に 3 倍かかる。
   * 一方で、ブラウザによって違うのは主に「読み込めるか」「触れるか」のところ
   * （React.lazy の分割読み込み、pointer / transform: scale、Intl の書式）で、
   * 権限や保存の話は 1 つのブラウザで見れば足りる。
   *
   * WebKit を落とさないのは、iPhone / iPad の Safari がこれだから。
   * このボードは会議室で手元の端末から開く使い方を想定しているので、
   * ここが動かないのに気づけないのは困る。
   * ただし画面の大きさは Desktop のまま。スマホの幅で崩れないかは
   * 別の話（レイアウトのテストが要る）なので、ここでは engine の違いだけを見る。
   */
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, grep: /@smoke/ },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, grep: /@smoke/ },
  ],

  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
