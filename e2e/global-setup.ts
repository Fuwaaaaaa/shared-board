import { loadEnv } from 'vite'

/*
 * Supabase につながるかを先に確かめる。
 *
 * つながらないときはテストを落とさずスキップにする。ブラウザのテストは
 * バックエンドが要る一方で、npm test（純粋関数とコンポーネント）は
 * 何も要らずに走る。片方の都合でもう片方が赤くなるのは避けたい。
 *
 * ただし CI では飛ばさずに落とす。飛ばしてよいのは「手元で npm test だけ
 * 回したい」ときの話で、CI で黙って 0 件になると、通ったのか何も走らなかった
 * のかが緑色から区別できない。
 *
 * ここで立てた環境変数は、この後に生まれるワーカーへ引き継がれる。
 */
export default async function globalSetup() {
  const env = loadEnv('development', process.cwd(), 'VITE_')
  const url = env.VITE_SUPABASE_URL
  const key = env.VITE_SUPABASE_ANON_KEY

  const giveUp = (reason: string) => {
    if (process.env.CI) throw new Error(`[e2e] ${reason}`)
    console.warn(`\n[e2e] ${reason} 今回は飛ばします。\n`)
  }

  if (!url || !key) {
    giveUp('.env.local に Supabase の設定がありません。')
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
    giveUp(`Supabase (${url}) につながりません: ${reason} npm run db:start を実行してください。`)
    return
  }

  process.env.E2E_BACKEND_READY = '1'
}
