import { loadEnv } from 'vite'

/*
 * Supabase につながるかを先に確かめる。
 *
 * つながらないときはテストを落とさずスキップにする。ブラウザのテストは
 * バックエンドが要る一方で、npm test（純粋関数とコンポーネント）は
 * 何も要らずに走る。片方の都合でもう片方が赤くなるのは避けたい。
 *
 * ここで立てた環境変数は、この後に生まれるワーカーへ引き継がれる。
 */
export default async function globalSetup() {
  const env = loadEnv('development', process.cwd(), 'VITE_')
  const url = env.VITE_SUPABASE_URL
  const key = env.VITE_SUPABASE_ANON_KEY

  if (!url || !key) {
    console.warn('\n[e2e] .env.local に Supabase の設定がありません。ブラウザのテストは飛ばします。\n')
    return
  }

  try {
    const response = await fetch(`${url}/rest/v1/rooms?select=id&limit=1`, {
      headers: { apikey: key },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    console.warn(
      `\n[e2e] Supabase (${url}) につながりません: ${reason}\n` +
        '      supabase start を実行してから、もう一度お試しください。今回は飛ばします。\n',
    )
    return
  }

  process.env.E2E_BACKEND_READY = '1'
}
