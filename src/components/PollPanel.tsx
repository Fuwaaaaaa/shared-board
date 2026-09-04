import { useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { ja } from 'date-fns/locale'
import Modal from './Modal'
import { supabase } from '../lib/supabase'
import { useIdentity } from '../lib/identity'
import { useRoomData } from '../lib/roomData'
import { getHolidayName } from '../lib/holidays'
import { allDayStartIso, boardDateTimeIso } from '../lib/dates'
import {
  POLL_ANSWER_LABELS,
  type CalendarEvent,
  type Poll,
  type PollAnswer,
  type PollOption,
} from '../lib/types'

interface Props {
  onClose: () => void
  /** 決定した候補日から予定を作る */
  onCreateEvent: (event: CalendarEvent) => Promise<void>
}

/** 日程調整（候補日に ○ △ × をつけて集計する） */
export default function PollPanel({ onClose, onCreateEvent }: Props) {
  const { userId, displayName } = useIdentity()
  const { roomId, canEdit, polls, pollOptions, pollVotes } = useRoomData()
  const [creating, setCreating] = useState(false)

  const sorted = useMemo(
    () => polls.rows.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [polls.rows],
  )

  async function vote(poll: Poll, option: PollOption, answer: PollAnswer) {
    const existing = pollVotes.rows.find(
      (v) => v.option_id === option.id && v.user_id === userId,
    )

    if (existing) {
      // 同じ答えをもう一度押したら取り消す
      if (existing.answer === answer) {
        pollVotes.removeLocal(existing.id)
        await supabase.from('poll_votes').delete().eq('id', existing.id)
        return
      }
      pollVotes.upsertLocal({ ...existing, answer })
      await supabase.from('poll_votes').update({ answer }).eq('id', existing.id)
      return
    }

    const row = {
      id: crypto.randomUUID(),
      poll_id: poll.id,
      option_id: option.id,
      room_id: roomId,
      user_id: userId,
      voter_name: displayName,
      answer,
      created_at: new Date().toISOString(),
    }
    pollVotes.upsertLocal(row)
    const { error } = await supabase.from('poll_votes').insert(row)
    if (error) pollVotes.removeLocal(row.id)
  }

  async function decide(poll: Poll, option: PollOption) {
    polls.upsertLocal({ ...poll, status: 'closed', decided_option_id: option.id })
    await supabase
      .from('polls')
      .update({ status: 'closed', decided_option_id: option.id })
      .eq('id', poll.id)

    const now = new Date().toISOString()
    await onCreateEvent({
      id: crypto.randomUUID(),
      room_id: roomId,
      // 日程調整で決まるのは「集まる日」なので、締切ではなく予定
      kind: 'event',
      title: poll.title,
      description: poll.description,
      start_at: option.start_at,
      end_at: option.end_at,
      all_day: option.all_day,
      color: 'green',
      recurrence: 'none',
      recurrence_until: null,
      remind_minutes: option.all_day ? 1440 : 60,
      tags: [],
      source_note_id: null,
      source_synced_at: null,
      deleted_at: null,
      author_id: userId,
      author_name: displayName,
      created_at: now,
      updated_at: now,
    })
  }

  async function reopen(poll: Poll) {
    polls.upsertLocal({ ...poll, status: 'open', decided_option_id: null })
    await supabase
      .from('polls')
      .update({ status: 'open', decided_option_id: null })
      .eq('id', poll.id)
  }

  async function removePoll(poll: Poll) {
    if (!window.confirm('この日程調整を削除します。よろしいですか？')) return
    polls.removeLocal(poll.id)
    await supabase.from('polls').delete().eq('id', poll.id)
  }

  return (
    <Modal title="日程調整" onClose={onClose}>
      {canEdit && (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="mb-4 w-full rounded-lg border border-dashed border-slate-300 py-2.5 text-sm text-slate-600 transition hover:border-slate-500 hover:bg-slate-50"
        >
          ＋ 新しい日程調整をつくる
        </button>
      )}

      {sorted.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-400">
          候補日を並べて、参加できる日を集めるための機能です。
        </p>
      ) : (
        <div className="space-y-6">
          {sorted.map((poll) => (
            <PollCard
              key={poll.id}
              poll={poll}
              options={pollOptions.rows
                .filter((o) => o.poll_id === poll.id)
                .sort((a, b) => a.sort - b.sort || a.start_at.localeCompare(b.start_at))}
              votes={pollVotes.rows.filter((v) => v.poll_id === poll.id)}
              userId={userId}
              canEdit={canEdit}
              onVote={vote}
              onDecide={decide}
              onReopen={reopen}
              onDelete={removePoll}
            />
          ))}
        </div>
      )}

      {creating && <CreatePollModal onClose={() => setCreating(false)} />}
    </Modal>
  )
}

function PollCard({
  poll,
  options,
  votes,
  userId,
  canEdit,
  onVote,
  onDecide,
  onReopen,
  onDelete,
}: {
  poll: Poll
  options: PollOption[]
  votes: { option_id: string; user_id: string; voter_name: string; answer: PollAnswer }[]
  userId: string
  canEdit: boolean
  onVote: (poll: Poll, option: PollOption, answer: PollAnswer) => void
  onDecide: (poll: Poll, option: PollOption) => void
  onReopen: (poll: Poll) => void
  onDelete: (poll: Poll) => void
}) {
  const tally = useMemo(() => {
    const map: Record<string, { yes: number; maybe: number; no: number; names: string[] }> = {}
    for (const option of options) map[option.id] = { yes: 0, maybe: 0, no: 0, names: [] }
    for (const vote of votes) {
      const entry = map[vote.option_id]
      if (!entry) continue
      entry[vote.answer]++
      if (vote.answer === 'yes') entry.names.push(vote.voter_name)
    }
    return map
  }, [options, votes])

  const best = useMemo(() => {
    let bestId: string | null = null
    let bestScore = -1
    for (const option of options) {
      const t = tally[option.id]
      const score = t.yes * 2 + t.maybe
      if (score > bestScore) {
        bestScore = score
        bestId = option.id
      }
    }
    return bestScore > 0 ? bestId : null
  }, [options, tally])

  const myVotes = new Map(
    votes.filter((v) => v.user_id === userId).map((v) => [v.option_id, v.answer]),
  )

  return (
    <section className="rounded-xl border border-slate-200 p-4">
      <div className="mb-1 flex items-start gap-2">
        <h3 className="min-w-0 flex-1 font-bold text-slate-800">{poll.title}</h3>
        {poll.status === 'closed' && (
          <span className="shrink-0 rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-700">
            決定済み
          </span>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={() => onDelete(poll)}
            className="shrink-0 text-xs text-slate-300 transition hover:text-rose-600"
          >
            削除
          </button>
        )}
      </div>
      {poll.description && (
        <p className="mb-3 text-sm whitespace-pre-wrap text-slate-600">{poll.description}</p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <tbody>
            {options.map((option) => {
              const t = tally[option.id]
              const start = parseISO(option.start_at)
              const holiday = getHolidayName(start)
              const mine = myVotes.get(option.id)
              const decided = poll.decided_option_id === option.id
              const recommended = best === option.id && poll.status === 'open'

              return (
                <tr
                  key={option.id}
                  className={`border-b border-slate-100 last:border-0 ${
                    decided ? 'bg-green-50' : recommended ? 'bg-amber-50/60' : ''
                  }`}
                >
                  <td className="py-2 pr-2 align-top">
                    <div className="text-slate-800">
                      {format(start, 'M/d(E)', { locale: ja })}
                      {!option.all_day && ` ${format(start, 'HH:mm')}`}
                      {option.end_at && !option.all_day && `〜${format(parseISO(option.end_at), 'HH:mm')}`}
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      {holiday && <span className="text-rose-500">{holiday}</span>}
                      <span className="text-slate-400">
                        ○{t.yes} △{t.maybe} ×{t.no}
                      </span>
                      {recommended && <span className="text-amber-600">いちばん集まる</span>}
                      {decided && <span className="text-green-700">この日に決定</span>}
                    </div>
                    {t.names.length > 0 && (
                      <div className="truncate text-xs text-slate-400">○ {t.names.join('、')}</div>
                    )}
                  </td>

                  <td className="w-32 py-2 align-top">
                    <div className="flex gap-1">
                      {(Object.keys(POLL_ANSWER_LABELS) as PollAnswer[]).map((answer) => (
                        <button
                          key={answer}
                          type="button"
                          title={POLL_ANSWER_LABELS[answer].label}
                          onClick={() => onVote(poll, option, answer)}
                          className={`h-8 w-8 rounded-lg border text-sm transition ${
                            mine === answer
                              ? 'border-slate-900 bg-slate-900 text-white'
                              : 'border-slate-300 text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          {POLL_ANSWER_LABELS[answer].mark}
                        </button>
                      ))}
                    </div>
                    {canEdit && poll.status === 'open' && (
                      <button
                        type="button"
                        onClick={() => onDecide(poll, option)}
                        className="mt-1 text-xs text-slate-500 transition hover:text-slate-900"
                      >
                        この日に決める
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {canEdit && poll.status === 'closed' && (
        <button
          type="button"
          onClick={() => onReopen(poll)}
          className="mt-2 text-xs text-slate-500 transition hover:text-slate-900"
        >
          決定を取り消して再調整する
        </button>
      )}
    </section>
  )
}

function CreatePollModal({ onClose }: { onClose: () => void }) {
  const { userId, displayName } = useIdentity()
  const { roomId, polls, pollOptions } = useRoomData()

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [allDay, setAllDay] = useState(true)
  const [time, setTime] = useState('19:00')
  const [dates, setDates] = useState<string[]>([])
  const [dateDraft, setDateDraft] = useState('')
  const [saving, setSaving] = useState(false)

  function addDate() {
    if (!dateDraft || dates.includes(dateDraft) || dates.length >= 15) return
    setDates((current) => [...current, dateDraft].sort())
    setDateDraft('')
  }

  async function submit() {
    if (!title.trim() || dates.length === 0 || saving) return
    setSaving(true)

    const poll: Poll = {
      id: crypto.randomUUID(),
      room_id: roomId,
      title: title.trim(),
      description: description.trim(),
      status: 'open',
      decided_option_id: null,
      author_id: userId,
      author_name: displayName,
      created_at: new Date().toISOString(),
    }

    const options: PollOption[] = dates.map((date, index) => {
      return {
        id: crypto.randomUUID(),
        poll_id: poll.id,
        room_id: roomId,
        // 候補日はボードの暦（JST）で解釈する
        start_at: allDay ? allDayStartIso(date) : boardDateTimeIso(date, time),
        end_at: null,
        all_day: allDay,
        sort: index,
      }
    })

    polls.upsertLocal(poll)
    for (const option of options) pollOptions.upsertLocal(option)

    const { error } = await supabase.from('polls').insert(poll)
    if (!error) await supabase.from('poll_options').insert(options)

    setSaving(false)
    onClose()
  }

  return (
    <Modal
      title="日程調整をつくる"
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
            disabled={!title.trim() || dates.length === 0 || saving}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:bg-slate-300"
          >
            作成
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <input
          autoFocus
          value={title}
          maxLength={80}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例：定例ミーティングの日程"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-slate-800"
        />

        <textarea
          value={description}
          maxLength={300}
          rows={2}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="ひとこと（任意）"
          className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800"
        />

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
            終日（時刻を決めない）
          </label>
          {!allDay && (
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800"
            />
          )}
        </div>

        <div>
          <span className="mb-1.5 block text-sm font-medium text-slate-700">
            候補日（最大 15 件）
          </span>
          <div className="mb-2 flex gap-2">
            <input
              type="date"
              value={dateDraft}
              onChange={(e) => setDateDraft(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800"
            />
            <button
              type="button"
              onClick={addDate}
              disabled={!dateDraft || dates.length >= 15}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
            >
              追加
            </button>
          </div>

          <ul className="space-y-1">
            {dates.map((date) => {
              const [y, m, d] = date.split('-').map(Number)
              const value = new Date(y, m - 1, d)
              const holiday = getHolidayName(value)
              return (
                <li key={date} className="flex items-center gap-2 text-sm">
                  <span className="text-slate-700">
                    {format(value, 'M月d日(E)', { locale: ja })}
                  </span>
                  {holiday && <span className="text-xs text-rose-500">{holiday}</span>}
                  <button
                    type="button"
                    onClick={() => setDates((current) => current.filter((x) => x !== date))}
                    className="ml-auto text-xs text-slate-400 transition hover:text-rose-600"
                  >
                    外す
                  </button>
                </li>
              )
            })}
            {dates.length === 0 && (
              <li className="text-xs text-slate-400">候補日をひとつ以上追加してください。</li>
            )}
          </ul>
        </div>
      </div>
    </Modal>
  )
}
