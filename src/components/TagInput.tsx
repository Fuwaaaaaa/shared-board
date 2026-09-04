import { useMemo, useState } from 'react'

interface Props {
  tags: string[]
  onChange: (tags: string[]) => void
  /** 同じボードで既に使われているタグ（候補として出す） */
  suggestions?: string[]
  disabled?: boolean
}

/** タグの追加・削除。Enter とカンマで確定する。 */
export default function TagInput({ tags, onChange, suggestions = [], disabled }: Props) {
  const [draft, setDraft] = useState('')

  const candidates = useMemo(() => {
    const query = draft.trim().toLowerCase()
    return suggestions
      .filter((tag) => !tags.includes(tag))
      .filter((tag) => !query || tag.toLowerCase().includes(query))
      .slice(0, 6)
  }, [suggestions, tags, draft])

  function add(value: string) {
    const trimmed = value.trim().replace(/^#/, '').slice(0, 20)
    if (!trimmed || tags.includes(trimmed) || tags.length >= 8) {
      setDraft('')
      return
    }
    onChange([...tags, trimmed])
    setDraft('')
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pr-1.5 pl-2 text-xs text-slate-700"
          >
            #{tag}
            {!disabled && (
              <button
                type="button"
                onClick={() => onChange(tags.filter((t) => t !== tag))}
                className="text-slate-400 transition hover:text-rose-600"
                aria-label={`${tag} を外す`}
              >
                ✕
              </button>
            )}
          </span>
        ))}
        {tags.length === 0 && <span className="text-xs text-slate-400">タグなし</span>}
      </div>

      {!disabled && (
        <>
          <input
            value={draft}
            maxLength={20}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault()
                add(draft)
              } else if (e.key === 'Backspace' && !draft && tags.length > 0) {
                onChange(tags.slice(0, -1))
              }
            }}
            onBlur={() => draft && add(draft)}
            placeholder={tags.length >= 8 ? 'タグは 8 個までです' : 'タグを追加して Enter'}
            disabled={tags.length >= 8}
            className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-slate-800 disabled:bg-slate-50"
          />

          {candidates.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {candidates.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => add(tag)}
                  className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-500 transition hover:bg-slate-50"
                >
                  #{tag}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** タグでの絞り込みバー */
export function TagFilterBar({
  allTags,
  selected,
  onToggle,
  onClear,
}: {
  allTags: string[]
  selected: string[]
  onToggle: (tag: string) => void
  onClear: () => void
}) {
  if (allTags.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-slate-400">タグ:</span>
      {allTags.map((tag) => {
        const active = selected.includes(tag)
        return (
          <button
            key={tag}
            type="button"
            onClick={() => onToggle(tag)}
            className={`rounded-full px-2.5 py-0.5 text-xs transition ${
              active
                ? 'bg-slate-900 text-white'
                : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
          >
            #{tag}
          </button>
        )
      })}
      {selected.length > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="text-xs text-slate-400 transition hover:text-slate-700"
        >
          解除
        </button>
      )}
    </div>
  )
}
