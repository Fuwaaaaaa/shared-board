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
  test: {
    // 純粋関数（繰り返し・祝日・ics・CSV）のテスト。ブラウザ環境は要らない
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    // ボードの暦は Asia/Tokyo 固定なので、テストも日本時間で走らせる。
    // TZ 依存を確かめるテストは vi.stubEnv('TZ', ...) で切り替える
    env: { TZ: 'Asia/Tokyo' },
  },
}))
