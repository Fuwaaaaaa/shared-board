import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  server: {
    // 同一LAN内の別端末から動作確認したいときだけ、.env.local に VITE_LAN=1 を
    // 書いて公開する。既定を localhost に閉じているのは、開発サーバーそのものが
    // 攻撃面になるため（同梱の esbuild には、開発サーバーが任意のファイルを
    // 読み出せてしまう既知の問題がある）。
    host: loadEnv(mode, '.', 'VITE_').VITE_LAN === '1',
    port: 5173,
  },
  build: {
    rollupOptions: {
      output: {
        /*
         * 変わりにくいものを別のかたまりに分ける。
         *
         * 画面を直すたびにファイル名が変わるのはアプリのぶんだけになるので、
         * 2 回目からは react や supabase-js を取りに行かなくて済む。
         * 画面ごとの分割（React.lazy）は src/App.tsx と src/pages/RoomPage.tsx 側。
         */
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          supabase: ['@supabase/supabase-js'],
          datefns: ['date-fns', 'date-fns/locale'],
        },
      },
    },
  },
  /*
   * テストを 2 つに分ける。分け方は「拡張子」。
   *
   *   *.test.ts   純粋関数（繰り返し・祝日・ics・CSV など）  → node
   *   *.test.tsx  React コンポーネント                        → jsdom
   *
   * 判断のあるところを src/lib/ の純粋関数へ押し出す方針は変えていない。
   * jsdom を足したのは、押し出せない部分（ドラッグの確定、フォーカスの戻し先など）
   * が実際にあるため。node のテストは今までどおりブラウザ環境なしで速く回る。
   *
   * もとは vitest.workspace.ts に置いていたが、その形は vitest 3 で非推奨・
   * 4 で廃止されたので、ここの projects へ移した。extends: true で
   * この設定（plugins と下の env）をそのまま継ぐ。
   */
  test: {
    // ボードの暦は Asia/Tokyo 固定なので、テストも日本時間で走らせる。
    // TZ 依存を確かめるテストは vi.stubEnv('TZ', ...) で切り替える
    env: { TZ: 'Asia/Tokyo' },
    projects: [
      {
        extends: true,
        test: {
          name: 'lib',
          include: ['src/**/__tests__/**/*.test.ts'],
          environment: 'node',
          // env は projects へ降りてこないので、どちらにも書く
          env: { TZ: 'Asia/Tokyo' },
        },
      },
      {
        extends: true,
        test: {
          name: 'ui',
          include: ['src/**/__tests__/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
          env: { TZ: 'Asia/Tokyo' },
        },
      },
    ],
  },
}))
