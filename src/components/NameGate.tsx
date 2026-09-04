import { useState } from 'react'
import { useIdentity } from '../lib/identity'

/**
 * 表示名の入力画面。
 * パスワードもメールアドレスも要らず、「誰が書いたか」を示すためだけの名前。
 */
export default function NameGate() {
  const { setDisplayName } = useIdentity()
  const [value, setValue] = useState('')

  const trimmed = value.trim()

  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 p-6">
      <form
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"
        onSubmit={(e) => {
          e.preventDefault()
          if (trimmed) setDisplayName(trimmed)
        }}
      >
        <div className="mb-6">
          <div className="mb-1 text-3xl">🗂️</div>
          <h1 className="text-xl font-bold text-slate-800">みんなのボード</h1>
          <p className="mt-1 text-sm text-slate-500">
            ホワイトボード・カレンダー・リマインドをみんなで共有します。
          </p>
        </div>

        <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="display-name">
          表示名を入力してください
        </label>
        <input
          id="display-name"
          autoFocus
          value={value}
          maxLength={30}
          onChange={(e) => setValue(e.target.value)}
          placeholder="例：たなか"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-800 outline-none focus:border-slate-800"
        />
        <p className="mt-2 text-xs text-slate-500">
          書き込みの横に表示されます。あとから変更できます。
        </p>

        <button
          type="submit"
          disabled={!trimmed}
          className="mt-6 w-full rounded-lg bg-slate-900 py-2.5 font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          はじめる
        </button>
      </form>
    </div>
  )
}
