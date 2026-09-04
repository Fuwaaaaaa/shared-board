/**
 * Cloudflare Turnstile（任意）。
 *
 * 匿名サインインは誰でも無制限に呼べるので、放っておくと auth.users を機械的に
 * 増やされたり、合言葉の総当たりに新しい ID を使い回されたりする。
 * VITE_TURNSTILE_SITE_KEY を設定すると、サインインの前に Turnstile を通す。
 * 空なら何もしない（getCaptchaToken() は null を返し、これまでどおり動く）。
 *
 * Supabase 側の設定: Authentication → Attack Protection → Enable CAPTCHA protection で
 * Turnstile を選び、Secret key を入れる。こうすると signInAnonymously / signInWithOtp に
 * captchaToken が必須になる（docs/SETUP.md「CAPTCHA」参照）。
 */

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: string | HTMLElement,
        options: {
          sitekey: string
          callback: (token: string) => void
          'error-callback'?: (code?: string) => void
          'expired-callback'?: () => void
          appearance?: 'always' | 'execute' | 'interaction-only'
          size?: 'normal' | 'compact' | 'flexible'
        },
      ) => string
      remove?: (widgetId: string) => void
    }
  }
}

const SITE_KEY = ((import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? '').trim()
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

/**
 * 応答を待つ上限。
 *
 * Turnstile は「コールバックを 1 つも呼ばない」ことがある（ネットワーク断、
 * challenges.cloudflare.com が塞がれている、拡張機能に止められている、
 * appearance: 'interaction-only' で見えないまま操作待ちになっている等）。
 * 上限が無いと、この Promise を待っている起動画面が永久に「読み込み中…」のままになり、
 * エラーも出ないので原因が分からない不具合になる。
 */
const TIMEOUT_MS = 30000

/** CAPTCHA を使う設定になっているか */
export const captchaEnabled = SITE_KEY !== ''

let scriptPromise: Promise<void> | null = null

/** Turnstile のスクリプトを 1 回だけ読み込む */
function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve()
  if (scriptPromise) return scriptPromise

  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT_SRC
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      scriptPromise = null
      reject(new Error('CAPTCHA の読み込みに失敗しました。ネットワークを確認してください'))
    }
    document.head.appendChild(script)
  })
  return scriptPromise
}

/**
 * CAPTCHA のトークンを取る。設定されていなければ null。
 *
 * ウィジェットは containerId の要素（無ければ body の末尾）に置く。
 * appearance: 'interaction-only' なので、ふつうは何も表示されずに通り、
 * 怪しいときだけチェックボックスが出る。
 */
export async function getCaptchaToken(containerId = 'turnstile-slot'): Promise<string | null> {
  if (!captchaEnabled) return null

  await loadScript()
  const turnstile = window.turnstile
  if (!turnstile) throw new Error('CAPTCHA を初期化できませんでした')

  let container = document.getElementById(containerId)
  if (!container) {
    container = document.createElement('div')
    // id を付けておかないと、次に呼んだときに見つけられず <div> が増え続ける
    container.id = containerId
    document.body.appendChild(container)
  }
  const slot = container

  return new Promise<string>((resolve, reject) => {
    let settled = false
    let widgetId: string | undefined
    let timer: number | undefined

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      if (timer !== undefined) window.clearTimeout(timer)
      // ウィジェットは使い捨て。残すと次に呼んだときに二重に描画される
      if (widgetId !== undefined) {
        try {
          turnstile.remove?.(widgetId)
        } catch {
          /* 破棄できなくても先へ進む */
        }
      }
      fn()
    }

    timer = window.setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              'CAPTCHA の応答がありません。ネットワークを確認して、もう一度お試しください',
            ),
          ),
        ),
      TIMEOUT_MS,
    )

    try {
      widgetId = turnstile.render(slot, {
        sitekey: SITE_KEY,
        appearance: 'interaction-only',
        callback: (token) => finish(() => resolve(token)),
        'error-callback': (code) =>
          finish(() => reject(new Error(`CAPTCHA でエラーが起きました${code ? ` (${code})` : ''}`))),
        'expired-callback': () =>
          finish(() => reject(new Error('CAPTCHA の有効期限が切れました。再読み込みしてください'))),
      })
    } catch (e) {
      finish(() => reject(e instanceof Error ? e : new Error(String(e))))
    }
  })
}
