import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { ensureSession, isSupabaseConfigured, supabase } from './supabase'
import { captchaEnabled, getCaptchaToken } from './captcha'
import { messageOf } from './errorMessage'

const NAME_KEY = 'board.displayName'

/**
 * 起動時のセッション確立。
 *
 * すでにセッションがあれば CAPTCHA は出さない。無いときだけ（設定されていれば）
 * Turnstile を通してから匿名サインインする。
 * StrictMode で effect が 2 回走っても 1 回しか動かないよう、Promise を共有する。
 */
let sessionPromise: Promise<string> | null = null

function startSession(): Promise<string> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const { data } = await supabase.auth.getSession()
      if (data.session?.user) return data.session.user.id
      const token = await getCaptchaToken()
      return ensureSession(token)
    })().catch((e: unknown) => {
      sessionPromise = null // 失敗したら次の試みで最初からやり直せるようにする
      throw e
    })
  }
  return sessionPromise
}

interface Identity {
  /** 匿名サインインで得た安定 ID（ブラウザごと） */
  userId: string
  /** 利用者が入力した表示名。未設定なら空文字 */
  displayName: string
  setDisplayName: (name: string) => void
}

const IdentityContext = createContext<Identity | null>(null)

export function useIdentity(): Identity {
  const ctx = useContext(IdentityContext)
  if (!ctx) throw new Error('useIdentity は IdentityProvider の内側で使ってください')
  return ctx
}

/**
 * 起動時に匿名サインインを済ませてから子を描画する。
 * 表示名は localStorage に持つだけで、サーバー側の認証には関与しない。
 */
export function IdentityProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [displayName, setDisplayNameState] = useState(
    () => localStorage.getItem(NAME_KEY) ?? '',
  )

  useEffect(() => {
    if (!isSupabaseConfigured) return
    startSession()
      .then(setUserId)
      .catch((e: unknown) => setError(messageOf(e)))
  }, [])

  /**
   * 表示名を変える。
   *
   * localStorage だけを書き換えると、他の人には参加したときの古い名前が
   * 出たままになる（参加者一覧・@メンションの候補・担当者の欄）。
   * 参加中のすべてのボードの自分の行もあわせて更新する。
   */
  function setDisplayName(name: string) {
    const trimmed = name.trim().slice(0, 30)
    localStorage.setItem(NAME_KEY, trimmed)
    setDisplayNameState(trimmed)

    if (!trimmed || !userId) return
    void supabase.from('room_members').update({ display_name: trimmed }).eq('user_id', userId)
  }

  if (!isSupabaseConfigured) return <SetupNotice />
  if (error) return <StartupError message={error} />
  if (!userId) return <Splash />

  return (
    <IdentityContext.Provider value={{ userId, displayName, setDisplayName }}>
      {children}
    </IdentityContext.Provider>
  )
}

function Splash() {
  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 text-slate-500">
      <div className="flex flex-col items-center gap-4">
        <div className="animate-pulse text-sm">読み込み中…</div>
        {/* Turnstile を使うときだけ、ここにウィジェットが出る（ふつうは見えないまま通る） */}
        {captchaEnabled && <div id="turnstile-slot" />}
      </div>
    </div>
  )
}

function StartupError({ message }: { message: string }) {
  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 p-6">
      <div className="max-w-lg rounded-xl border border-rose-200 bg-white p-6 shadow-sm">
        <h1 className="mb-2 text-lg font-bold text-rose-700">接続できませんでした</h1>
        <p className="mb-4 text-sm text-slate-600">{message}</p>
        <p className="text-sm text-slate-600">
          Supabase の Authentication → Sign In / Providers で
          <strong className="font-semibold">「Anonymous sign-ins」</strong>
          が有効になっているか確認してください。手順は
          <code className="mx-1 rounded bg-slate-100 px-1">docs/SETUP.md</code>
          にあります。
        </p>
      </div>
    </div>
  )
}

function SetupNotice() {
  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 p-6">
      <div className="max-w-lg rounded-xl border border-amber-200 bg-white p-6 shadow-sm">
        <h1 className="mb-3 text-lg font-bold text-slate-800">セットアップが必要です</h1>
        <p className="mb-3 text-sm text-slate-600">
          Supabase の接続情報がまだ設定されていません。
          <code className="mx-1 rounded bg-slate-100 px-1">.env.example</code>
          を <code className="mx-1 rounded bg-slate-100 px-1">.env.local</code> にコピーし、
          次の 2 つを記入して開発サーバーを再起動してください。
        </p>
        <pre className="mb-3 overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
{`VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...`}
        </pre>
        <p className="text-sm text-slate-600">
          詳しい手順は <code className="rounded bg-slate-100 px-1">docs/SETUP.md</code> にあります。
        </p>
      </div>
    </div>
  )
}
