/*
 * 例外を、人に見せる 1 行にする。
 *
 * Supabase が返すエラー（PostgrestError / AuthError / FunctionsError）は
 * Error のインスタンスではなく、message を持つただのオブジェクトで来る。
 * そのため `e instanceof Error ? e.message : String(e)` と書くと、
 * サーバーが理由を返しているのに画面には "[object Object]" と出る。
 *
 * 実際、合言葉つきのボードを作れないときにこれが起きていた。
 * サーバーは「合言葉は 6 文字以上にしてください」と言っていたのに、
 * 画面には "[object Object]" しか出ず、何が悪いのか分からなかった。
 */

/** 見せるものが無いときの最後の砦。空欄よりはましな一言 */
const FALLBACK = '原因不明のエラーが起きました'

export function messageOf(e: unknown): string {
  if (typeof e === 'string') return e.trim() || FALLBACK

  if (e && typeof e === 'object') {
    // Supabase のエラーはここに落ちる（Error ではないが message を持つ）
    const message = (e as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message.trim()

    // Edge Function からの応答など、message が無くても手掛かりがあることがある
    for (const key of ['error_description', 'error', 'details', 'hint'] as const) {
      const value = (e as Record<string, unknown>)[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }

  if (e instanceof Error && e.message.trim()) return e.message.trim()

  const text = String(e)
  // String({}) が "[object Object]" になるだけの結果は見せない
  return text.startsWith('[object ') || !text.trim() ? FALLBACK : text
}
