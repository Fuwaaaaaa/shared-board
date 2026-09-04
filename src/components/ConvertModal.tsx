import { useState } from 'react'
import { format, parseISO } from 'date-fns'
import { ja } from 'date-fns/locale'
import Modal from './Modal'
import TagInput from './TagInput'
import { splitNoteText } from '../lib/convert'
import { REMIND_OPTIONS, type Note } from '../lib/types'

export type ConvertTarget = 'todo' | 'event' | 'deadline' | 'both'

export interface ConvertPlan {
  target: ConvertTarget
  /** 付箋 1 枚のときだけ使う。複数枚のときは各付箋の 1 行目をそのまま使う */
  title: string
  notes: string
  /** 'yyyy-MM-dd'。空なら期限なし（予定を作るときは必須） */
  date: string
  time: string
  allDay: boolean
  assigneeId: string
  remind: number | null
  tags: string[]
}

interface Props {
  notes: Note[]
  initialTarget: ConvertTarget
  allTags: string[]
  members: { id: string; name: string }[]
  onSubmit: (plan: ConvertPlan) => Promise<void>
  onClose: () => void
}

const TARGETS: { key: ConvertTarget; label: string; hint: string }[] = [
  { key: 'todo', label: '⏰ やること', hint: 'リマインドに追加します' },
  { key: 'event', label: '📅 予定', hint: 'その日時に集まる・行うこととしてカレンダーに入れます' },
  { key: 'deadline', label: '⏰ 締切', hint: 'その日までに終えることとして、カレンダーの終日欄に出します' },
  { key: 'both', label: '両方', hint: '予定を作り、その準備もやることに入れます' },
]

/**
 * 付箋を「やること」や「予定」に変える。
 *
 * 付箋に書いたことがそのまま行動になる導線なので、
 * 最短で決められるよう項目は担当・日時・タグだけに絞っている。
 */
export default function ConvertModal({
  notes,
  initialTarget,
  allTags,
  members,
  onSubmit,
  onClose,
}: Props) {
  const single = notes.length === 1 ? notes[0] : null
  const parsed = single ? splitNoteText(single.text) : { title: '', body: '' }

  const [target, setTarget] = useState<ConvertTarget>(initialTarget)
  const [title, setTitle] = useState(parsed.title)
  const [body, setBody] = useState(parsed.body)
  const [date, setDate] = useState(
    initialTarget === 'todo' ? '' : format(new Date(), 'yyyy-MM-dd'),
  )
  const [time, setTime] = useState('09:00')
  const [allDay, setAllDay] = useState(true)
  const [assigneeId, setAssigneeId] = useState('')
  const [remind, setRemind] = useState<number | null>(null)
  const [tags, setTags] = useState<string[]>(single ? (single.tags ?? []) : [])
  const [saving, setSaving] = useState(false)

  const needsDate = target !== 'todo'
  // 締切は「その日まで」なので時刻は持たせない（カレンダーの終日欄に出す）
  const effectiveAllDay = target === 'deadline' ? true : allDay
  const titleMissing = single !== null && !title.trim()
  const blocked = saving || titleMissing || (needsDate && !date)

  function changeTarget(next: ConvertTarget) {
    setTarget(next)
    // 予定・締切には日付が要るので、空なら今日を入れておく
    if (next !== 'todo' && !date) setDate(format(new Date(), 'yyyy-MM-dd'))
  }

  async function submit() {
    if (blocked) return
    setSaving(true)
    await onSubmit({
      target,
      title: title.trim(),
      notes: body.trim(),
      date,
      time,
      allDay: effectiveAllDay,
      assigneeId,
      remind,
      tags,
    })
    setSaving(false)
  }

  const assigneeName = members.find((m) => m.id === assigneeId)?.name ?? ''
  const when = date
    ? `${format(parseISO(date), 'M月d日(E)', { locale: ja })}${
        target !== 'todo' && effectiveAllDay ? '' : ` ${time}`
      }${target === 'deadline' ? ' まで' : ''}`
    : ''

  return (
    <Modal
      title={single ? '付箋から作る' : `${notes.length} 枚の付箋から作る`}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 transition hover:bg-slate-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={blocked}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:bg-slate-300"
          >
            {saving ? '作成中…' : '作る'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <span className="mb-1.5 block text-sm font-medium text-slate-700">何にする？</span>
          <div className="flex flex-wrap gap-2">
            {TARGETS.map((option) => (
              <button
                key={option.key}
                type="button"
                title={option.hint}
                onClick={() => changeTarget(option.key)}
                className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                  target === option.key
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 text-slate-600 hover:border-slate-400'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            {TARGETS.find((t) => t.key === target)?.hint}
          </p>
        </div>

        {single ? (
          <>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">タイトル</label>
              <input
                autoFocus
                value={title}
                maxLength={100}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="付箋の 1 行目が入ります"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-slate-800"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">メモ</label>
              <textarea
                value={body}
                maxLength={500}
                rows={2}
                onChange={(e) => setBody(e.target.value)}
                placeholder="付箋の 2 行目以降が入ります"
                className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800"
              />
            </div>
          </>
        ) : (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            選んだ付箋それぞれの 1 行目がタイトルになります。下の設定は全部に同じものが付きます。
          </p>
        )}

        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">
            {target === 'todo' ? '期限' : target === 'deadline' ? '締切の日' : '日時'}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              value={date}
              onChange={(e) => {
                const value = e.target.value
                setDate(value)
                if (value && !date && remind === null) setRemind(0)
              }}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800"
            />
            <input
              type="time"
              value={time}
              disabled={!date || (target !== 'todo' && effectiveAllDay)}
              onChange={(e) => setTime(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800 disabled:bg-slate-50 disabled:text-slate-400"
            />
            {target === 'todo' && date && (
              <button
                type="button"
                onClick={() => setDate('')}
                className="text-sm text-slate-400 transition hover:text-slate-700"
              >
                期限をなくす
              </button>
            )}
          </div>

          {target === 'event' && (
            <label className="mt-2 flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={allDay}
                onChange={(e) => setAllDay(e.target.checked)}
              />
              終日
            </label>
          )}

          {target === 'deadline' && (
            <p className="mt-1.5 text-xs text-slate-500">
              締切はその日の終日欄に出ます。時刻は持ちません。
            </p>
          )}

          {needsDate && !date && (
            <p className="mt-1.5 text-xs text-rose-600">
              {target === 'deadline' ? '締切には日付が必要です。' : '予定を作るには日付が必要です。'}
            </p>
          )}
        </div>

        {date && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            通知
            <select
              value={remind === null ? '' : String(remind)}
              onChange={(e) => setRemind(e.target.value === '' ? null : Number(e.target.value))}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800"
            >
              {REMIND_OPTIONS.map((option) => (
                <option key={String(option.value)} value={option.value === null ? '' : option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )}

        {(target === 'todo' || target === 'both') && (
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">担当</label>
            <select
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800"
            >
              <option value="">未割り当て</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name || '名前なし'}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <span className="mb-1.5 block text-sm font-medium text-slate-700">タグ</span>
          <TagInput tags={tags} suggestions={allTags} onChange={setTags} />
        </div>

        {target === 'todo' && date && (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            期限のあるやることは、カレンダーにも重ねて表示されます（カレンダーの ⏰ で切り替え）。
          </p>
        )}

        <p className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600">
          {target === 'event' ? '📅' : '⏰'}{' '}
          <span className="font-medium">{single ? title || '（タイトル未入力）' : `${notes.length} 件`}</span>
          {when && ` ／ ${when}`}
          {assigneeName && (target === 'todo' || target === 'both') && ` ／ 担当 ${assigneeName}`}
          <br />
          もとの付箋は残ります。あとから「どの付箋から生まれたか」をたどれます。
          <br />
          作ったあとは別々のものになります。付箋を直しても自動では変わらず、
          「元が変更されています」とお知らせが出るので、反映するかどうかを選べます。
        </p>
      </div>
    </Modal>
  )
}
