import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type ThemeChoice = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'board.theme'

interface ThemeContextValue {
  choice: ThemeChoice
  /** 実際に適用されている見た目 */
  resolved: 'light' | 'dark'
  setChoice: (choice: ThemeChoice) => void
  /** light → dark → system → light と切り替える */
  cycle: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme は ThemeProvider の内側で使ってください')
  return ctx
}

function readStored(): ThemeChoice {
  const value = localStorage.getItem(STORAGE_KEY)
  return value === 'light' || value === 'dark' ? value : 'system'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(readStored)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
  )

  // OS 側の設定が変わったら追従する
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const resolved: 'light' | 'dark' =
    choice === 'system' ? (systemDark ? 'dark' : 'light') : choice

  useEffect(() => {
    document.documentElement.dataset.theme = resolved
  }, [resolved])

  function setChoice(next: ThemeChoice) {
    if (next === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, next)
    setChoiceState(next)
  }

  function cycle() {
    setChoice(choice === 'light' ? 'dark' : choice === 'dark' ? 'system' : 'light')
  }

  return (
    <ThemeContext.Provider value={{ choice, resolved, setChoice, cycle }}>
      {children}
    </ThemeContext.Provider>
  )
}

/** ヘッダーに置く小さな切り替えボタン */
export function ThemeToggle() {
  const { choice, cycle } = useTheme()
  const label =
    choice === 'light' ? 'ライト' : choice === 'dark' ? 'ダーク' : 'OS に合わせる'
  const icon = choice === 'light' ? '☀️' : choice === 'dark' ? '🌙' : '🖥'

  return (
    <button
      type="button"
      onClick={cycle}
      title={`表示テーマ: ${label}（クリックで切り替え）`}
      className="rounded-full border border-slate-200 px-2.5 py-1.5 text-sm text-slate-600 transition hover:bg-slate-50"
    >
      {icon}
    </button>
  )
}
