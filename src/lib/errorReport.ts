/**
 * ブラウザ側で起きたエラーを client_errors テーブルに送る。
 *
 * 外部の計測サービスは使わず、Supabase の 1 テーブルに書くだけ。
 * 見るときはダッシュボードの SQL Editor から（docs/SETUP.md「ブラウザ側のエラーを見る」）。
 *
 * 送りすぎない・漏らさないための決まり:
 *   - 同じ message + stack は 60 秒に 1 回
 *   - 全体で毎分 5 件まで（サーバー側でも 1 人 10 件/分で切る）
 *   - オフライン中は捨てる。書き込みには送信箱（lib/writeQueue.ts）があるが、
 *     エラー報告はそこに載せない。報告の失敗が「保存できませんでした」に
 *     見えると、本当の保存失敗と区別がつかなくなる
 *   - ブラウザ拡張（chrome-extension://）と ResizeObserver の警告は無視
 *   - url は location.pathname だけ（?owner=... のようなクエリは送らない）
 *   - 各項目は DB の上限（tg_limit_text）に合わせて切る
 *   - セッションが無ければ捨てる（RLS で user_id = auth.uid() が要る）
 *   - 送信の失敗は握りつぶす（エラー報告がエラーを呼ぶ連鎖を作らない）
 */

import { supabase } from './supabase'

const LIMITS = { message: 1000, stack: 5000, url: 500, ua: 300 } as const
const SAME_ERROR_INTERVAL_MS = 60_000
const MAX_PER_MINUTE = 5

let currentRoomId: string | null = null
let installed = false

/** message+stack → 最後に送った時刻 */
const lastSentAt = new Map<string, number>()
let windowStartedAt = 0
let windowCount = 0

/** いま開いているボード。RoomPage が設定し、離れたら null に戻す */
export function setErrorContext(context: { roomId: string | null }): void {
  currentRoomId = context.roomId
}

function describe(error: unknown): { message: string; stack: string } {
  if (error instanceof Error) {
    return { message: error.message || error.name, stack: error.stack ?? '' }
  }
  if (typeof error === 'string') return { message: error, stack: '' }
  if (error && typeof error === 'object') {
    const obj = error as { message?: unknown; stack?: unknown }
    if (typeof obj.message === 'string') {
      return { message: obj.message, stack: typeof obj.stack === 'string' ? obj.stack : '' }
    }
    try {
      return { message: JSON.stringify(error).slice(0, 300), stack: '' }
    } catch {
      return { message: String(error), stack: '' }
    }
  }
  return { message: String(error), stack: '' }
}

function shouldIgnore(message: string, stack: string): boolean {
  if (!message || message === 'Script error.') return true // 他ドメインのスクリプト（中身が分からない）
  if (message.includes('ResizeObserver loop')) return true
  if (message.includes('chrome-extension://') || stack.includes('chrome-extension://')) return true
  if (message.includes('moz-extension://') || stack.includes('moz-extension://')) return true
  return false
}

/** 送ってよいか（重複・流量・オフライン） */
function allow(message: string, stack: string): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false

  const now = Date.now()
  const key = `${message}\n${stack}`
  const previous = lastSentAt.get(key)
  if (previous !== undefined && now - previous < SAME_ERROR_INTERVAL_MS) return false

  if (now - windowStartedAt >= 60_000) {
    windowStartedAt = now
    windowCount = 0
  }
  if (windowCount >= MAX_PER_MINUTE) return false

  windowCount += 1
  lastSentAt.set(key, now)

  // 古い記録は捨てる（増え続けないように）
  if (lastSentAt.size > 200) {
    for (const [k, t] of lastSentAt) if (now - t >= SAME_ERROR_INTERVAL_MS) lastSentAt.delete(k)
  }
  return true
}

/** エラーを 1 件送る。呼び出し側で catch しなくてよい（決して例外を投げない） */
export function reportError(error: unknown): void {
  try {
    const { message, stack } = describe(error)
    if (shouldIgnore(message, stack)) return
    if (!allow(message, stack)) return

    const row = {
      room_id: currentRoomId,
      message: message.slice(0, LIMITS.message),
      stack: stack.slice(0, LIMITS.stack),
      url: window.location.pathname.slice(0, LIMITS.url),
      ua: navigator.userAgent.slice(0, LIMITS.ua),
    }

    void supabase.auth.getSession().then(
      ({ data }) => {
        const user = data.session?.user
        if (!user) return
        void supabase
          .from('client_errors')
          .insert({ ...row, user_id: user.id })
          .then(
            () => undefined,
            () => undefined,
          )
      },
      () => undefined,
    )
  } catch {
    // 報告に失敗してもアプリは止めない
  }
}

/** window の error / unhandledrejection を拾う。何度呼んでも 1 回しか仕掛けない */
export function installErrorReporting(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  window.addEventListener('error', (event) => {
    // 画像やスクリプトの読み込み失敗は ErrorEvent ではなく、message も error も無い
    if (!(event instanceof ErrorEvent)) return
    reportError(event.error ?? event.message)
  })

  window.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason)
  })
}
