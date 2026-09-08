import { createClient } from '@supabase/supabase-js'
import { beginWrite, endWrite } from './syncStatus'
import { getCaptchaToken } from './captcha'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/** .env.local が未設定なら画面に案内を出せるようにフラグ化しておく */
export const isSupabaseConfigured = Boolean(url && anonKey && !url.includes('xxxxxxxx'))

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

/**
 * 書き込みリクエストだけを数えて「保存済み / 同期中」の表示に使う。
 *
 * 保存は各タブの中で個別に行われていて数が多いので、呼び出し側には手を入れず
 * HTTP の出入口でまとめて見る。読み取り（GET）とログイン処理は数えない。
 */
function trackedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const isDataWrite =
    WRITE_METHODS.has(method) &&
    (href.includes('/rest/v1/') || href.includes('/storage/v1/')) &&
    // エラー報告（errorReport.ts）の送信は数えない。
    // 報告が失敗したときに「保存できませんでした」と出ると、本当の保存失敗と区別がつかない
    !href.includes('/rest/v1/client_errors')

  if (!isDataWrite) return fetch(input, init)

  beginWrite()
  return fetch(input, init).then(
    (response) => {
      endWrite(response.ok)
      return response
    },
    (error: unknown) => {
      endWrite(false)
      /*
       * 通信そのものが届かなかったことに、ここで印を付ける。
       *
       * navigator.onLine は true のまま回線が死んでいることが普通にある
       * （キャプティブポータル、不安定なモバイル）ので、フラグでは判定できない。
       * supabase-js は投げられた fetch のエラーを
       * { message: 'TypeError: Failed to fetch' } に潰してしまうため、
       * 送信箱側は文言でも見分けられるようにしてある（lib/writeQueue.ts）。
       */
      if (error && typeof error === 'object') {
        ;(error as { isTransport?: boolean }).isTransport = true
      }
      throw error
    },
  )
}

export const supabase = createClient(url ?? 'http://localhost', anonKey ?? 'anon', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
  realtime: {
    params: { eventsPerSecond: 20 },
  },
  global: {
    fetch: trackedFetch,
  },
})

// 開発中だけ、ブラウザの Console から RLS の効き目を確認できるようにする。
// 例: await supabase.from('notes').select('*')  → 権限がなければ 0 件
if (import.meta.env.DEV) {
  ;(window as unknown as { supabase: typeof supabase }).supabase = supabase
}

/**
 * 匿名サインイン。
 * ユーザーは何も入力しないが、ブラウザごとに安定した auth.uid() が得られるので
 * RLS で「このルームのオーナーは誰か」「承認済みか」を判定できる。
 *
 * captchaToken は Turnstile を有効にしているときだけ要る（src/lib/captcha.ts）。
 * Supabase 側で CAPTCHA を必須にしていると、トークン無しのサインインは拒否される。
 * 省略された場合はここで取りに行くので、呼び出し側は気にしなくてよい
 * （起動時だけは、表示の都合で identity.tsx が先に取ってから渡している）。
 */
export async function ensureSession(captchaToken?: string | null): Promise<string> {
  const { data } = await supabase.auth.getSession()
  if (data.session?.user) return data.session.user.id

  const token = captchaToken ?? (await getCaptchaToken())

  const { data: signedIn, error } = await supabase.auth.signInAnonymously(
    token ? { options: { captchaToken: token } } : undefined,
  )
  if (error) throw error
  if (!signedIn.user) throw new Error('匿名サインインに失敗しました')
  return signedIn.user.id
}

/** URL に使う短いランダムコード */
export function generateSlug(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10)
}
