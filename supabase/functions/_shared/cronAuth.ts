/*
 * pg_cron から呼ばれる Edge Function（send-reminders / purge-storage）の入口の認証。
 *
 * この 2 つは supabase/config.toml で verify_jwt = false にしている。
 * ゲートウェイでの検証が無いということは、インターネットのどこからでも
 * この URL に到達できるということなので、ここが唯一の壁になる。
 *
 * （board-ics も verify_jwt = false だが、あちらはカレンダーアプリが取りに来るので
 *   共有シークレットではなく、URL に埋めた購読トークンで照合する。ここは通らない）
 *
 * 以前は service_role キーそのものを Authorization ヘッダで受け取り、
 * 単純な文字列比較で照合していた。2 つ問題がある:
 *
 *   1. service_role キーを毎分ネットワークに流すことになる。しかも pg_net は
 *      送信前のリクエストをヘッダごと DB のテーブル（net.http_request_queue）に
 *      積むので、鍵が平文で DB に残る。漏れれば RLS がすべて無効になる。
 *   2. `!==` は先頭から違うところまでで返るので、比較にかかる時間が入力に依存する。
 *
 * そこで専用の合言葉（CRON_SHARED_SECRET）に分け、比較も一定時間にした。
 * 合言葉は supabase/cron.sql が生成して Vault に保存する。
 *
 * 設定:
 *   select decrypted_secret from vault.decrypted_secrets where name = 'cron_shared_secret';
 *   supabase secrets set CRON_SHARED_SECRET=<その値>
 */

const SECRET = Deno.env.get('CRON_SHARED_SECRET') ?? ''

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return new Uint8Array(digest)
}

/**
 * 合言葉が一致するか。
 *
 * 生の文字列ではなく SHA-256 の 32 バイト同士を比べる。こうすると長さが必ず揃うので、
 * 「どこまで合っていたか」も「何文字だったか」も、かかる時間から読み取れない。
 * CRON_SHARED_SECRET が未設定のときは誰も通さない（開けっ放しにしない）。
 */
export async function isCronCaller(req: Request): Promise<boolean> {
  if (SECRET === '') return false

  const given = req.headers.get('x-cron-secret') ?? ''
  if (given === '') return false

  const [a, b] = await Promise.all([sha256(given), sha256(SECRET)])
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}
