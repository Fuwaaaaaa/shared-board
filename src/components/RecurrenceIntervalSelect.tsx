import {
  RECURRENCE_INTERVAL_UNITS,
  intervalOptionsFor,
  type Recurrence,
} from '../lib/types'

interface Props {
  recurrence: Recurrence
  interval: number
  onChange: (interval: number) => void
}

/**
 * 「n 回ごと」の選び方。カレンダーとリマインドで同じものを使う。
 *
 * 数値の入力欄にしていないのは、空文字・0・全角のような「入っていておかしい値」を
 * 構造的に作れなくするため。周期ごとに選べる数が違う（毎週なら 4 週まで、
 * 毎月なら 6 か月まで）ので、選択肢は lib/types.ts の intervalOptionsFor に置いてある。
 *
 * 曜日の選び方（CalendarTab の RecurrenceFields と TodoTab の TodoRecurrenceFields）は
 * 画面ごとに寸法と受け取り方が違う双子だが、こちらは select 1 つなので分ける理由がない。
 */
export default function RecurrenceIntervalSelect({ recurrence, interval, onChange }: Props) {
  if (recurrence === 'none') return null

  const options = intervalOptionsFor(recurrence)
  const unit = RECURRENCE_INTERVAL_UNITS[recurrence]

  /*
   * いま入っている値が、並べた選択肢に無いことがある。取り込んだ .ics や CSV は
   * 1〜99 を通すので（csv.ts の parseInterval と、DB の CHECK）、
   * 「8 週ごと」のようにこの画面が並べていない値が来る。
   * 混ぜておかないと select が空欄になり、何が入っているのか読めなくなる。
   */
  const choices = options.includes(interval)
    ? options
    : [...options, interval].sort((a, b) => a - b)

  return (
    <span className="flex items-center gap-1.5">
      <select
        aria-label="何回ごとか"
        value={String(interval)}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800 disabled:bg-slate-50"
      >
        {choices.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
      <span className="text-sm text-slate-500">{unit}ごと</span>
    </span>
  )
}
