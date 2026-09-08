import { tallyAttendance } from '../lib/attendance'
import { ATTENDANCE_ANSWER_LABELS, type AttendanceAnswer, type EventAttendance } from '../lib/types'
import type { RoomMember } from '../lib/types'

interface Props {
  /** その回に付いている出欠だけを渡す（attendanceFor で絞ったもの） */
  rows: EventAttendance[]
  approvedMembers: RoomMember[]
  /** 自分の答え。まだ答えていなければ null */
  mine: AttendanceAnswer | null
  /** 終了したボードでは答えも取り下げもできない（サーバー側の判定と対になっている） */
  disabled: boolean
  onAnswer: (answer: AttendanceAnswer) => void
}

/**
 * 予定 1 回分の出欠。
 *
 * 見た目は日程調整（PollPanel）にそろえる。「○△×を押す」という同じ操作なので、
 * 別のかたちにすると同じ画面の中で作法が 2 つになる。
 *
 * 押せるのは「閲覧のみ」の参加者も同じ。行く・行けないはボードの編集ではないし、
 * むしろ書き込めない人こそ言いたいことなので、サーバー側もコメントや投票と
 * 同じ層（can_access_room + room_is_open + 自分の行だけ）で通している。
 */
export default function AttendancePanel({
  rows,
  approvedMembers,
  mine,
  disabled,
  onAnswer,
}: Props) {
  const tally = tallyAttendance(rows, approvedMembers)

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm font-medium text-slate-700">出欠</span>

        <div className="flex gap-1">
          {(Object.keys(ATTENDANCE_ANSWER_LABELS) as AttendanceAnswer[]).map((answer) => (
            <button
              key={answer}
              type="button"
              disabled={disabled}
              aria-pressed={mine === answer}
              title={ATTENDANCE_ANSWER_LABELS[answer].label}
              onClick={() => onAnswer(answer)}
              className={`h-8 w-8 rounded-lg border text-sm transition disabled:opacity-50 ${
                mine === answer
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-300 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {ATTENDANCE_ANSWER_LABELS[answer].mark}
            </button>
          ))}
        </div>

        <span className="text-sm text-slate-600">
          ○{tally.yes} △{tally.maybe} ×{tally.no}
        </span>

        {tally.unanswered > 0 && (
          <span className="text-xs text-slate-400" title={tally.pendingNames.join('、')}>
            まだ {tally.unanswered} 人
          </span>
        )}
      </div>

      {tally.yesNames.length > 0 && (
        <p className="mt-1.5 truncate text-xs text-slate-400" title={tally.yesNames.join('、')}>
          ○ {tally.yesNames.join('、')}
        </p>
      )}

      {mine !== null && !disabled && (
        <button
          type="button"
          onClick={() => onAnswer(mine)}
          className="mt-1.5 text-xs text-slate-400 transition hover:text-slate-700"
        >
          答えを取り消す
        </button>
      )}
    </div>
  )
}
