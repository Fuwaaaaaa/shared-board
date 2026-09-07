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
  test: {
    // どのファイルをどの環境で走らせるかは vitest.workspace.ts が決める。
    // ここに include を置くと、継承した先で連結されて二重に走る
    //
    // ボードの暦は Asia/Tokyo 固定なので、テストも日本時間で走らせる。
    // TZ 依存を確かめるテストは vi.stubEnv('TZ', ...) で切り替える
    env: { TZ: 'Asia/Tokyo' },
  },
}))
