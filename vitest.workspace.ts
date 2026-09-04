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
 * どちらも vite.config.ts を継いでいるので、暦の TZ=Asia/Tokyo は共通。
 */

export default [
  {
    extends: './vite.config.ts',
    test: {
      name: 'lib',
      include: ['src/**/__tests__/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    extends: './vite.config.ts',
    test: {
      name: 'ui',
      include: ['src/**/__tests__/**/*.test.tsx'],
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
    },
  },
]
