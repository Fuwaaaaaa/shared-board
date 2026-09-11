import { describe, expect, it } from 'vitest'
import {
  bucketOfDue,
  bucketOfOccurrence,
  buildOverview,
  countOverview,
  OVERVIEW_DAYS,
  type OverviewRoom,
} from '../overview'
import { boardDateTimeIso } from '../dates'
import type { CalendarEvent, EventOverride, Todo } from '../types'

/*
 * ホーム画面の「自分の番」。
 *
 * 区切りが重ならないこと（足して合うこと）と、予定に「期限切れ」が無いことが
 * ここでいちばん見たいところ。画面では 4 つの数として出るので、
 * 重なっていると合計が合わない。
 */

const ROOMS: OverviewRoom[] = [
  { id: 'r1', slug: 'aaaaaa', name: '合宿' },
  { id: 'r2', slug: 'bbbbbb', name: '部会' },
]

/** 2026-09-11（金）15:00 を「いま」とする */
const NOW = new Date(boardDateTimeIso('2026-09-11', '15:00'))

function makeTodo(patch: Partial<Todo> & { id: string }): Todo {
  return {
    room_id: 'r1',
    title: 'やること',
    notes: '',
    due_at: null,
    done: false,
    done_at: null,
    assignee_id: 'me',
    assignee_name: 'わたし',
    remind_minutes: null,
    recurrence: 'none',
    recurrence_days: [],
    recurrence_week: null,
    recurrence_interval: null,
    subtasks: [],
    tags: [],
    status: 'todo',
    sort_order: 0,
    source_note_id: null,
    source_event_id: null,
    source_todo_id: null,
    deleted_at: null,
    author_id: 'u1',
    author_name: 'A',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...patch,
  } as Todo
}

function makeEvent(patch: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    room_id: 'r1',
    kind: 'event',
    title: '打ち合わせ',
    description: '',
    start_at: boardDateTimeIso('2026-09-11', '10:00'),
    end_at: boardDateTimeIso('2026-09-11', '11:00'),
    all_day: false,
    color: 'blue',
    recurrence: 'none',
    recurrence_days: [],
    recurrence_week: null,
    recurrence_interval: null,
    recurrence_until: null,
    remind_minutes: null,
    tags: [],
    source_note_id: null,
    source_synced_at: null,
    deleted_at: null,
    author_id: 'u1',
    author_name: 'A',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...patch,
  } as CalendarEvent
}

const NO_OVERRIDES: EventOverride[] = []

describe('bucketOfDue', () => {
  it('過ぎた期限は「期限切れ」', () => {
    expect(bucketOfDue(new Date(boardDateTimeIso('2026-09-11', '14:59')), NOW)).toBe('overdue')
  })

  it('ちょうど「いま」も期限切れ（1 秒ごとに揺れないよう、境目は過ぎた側に倒す）', () => {
    expect(bucketOfDue(NOW, NOW)).toBe('overdue')
  })

  it('今日のこれから', () => {
    expect(bucketOfDue(new Date(boardDateTimeIso('2026-09-11', '23:59')), NOW)).toBe('today')
  })

  it('明日から 7 日後までは「今週」', () => {
    expect(bucketOfDue(new Date(boardDateTimeIso('2026-09-12', '09:00')), NOW)).toBe('week')
    expect(bucketOfDue(new Date(boardDateTimeIso('2026-09-18', '14:00')), NOW)).toBe('week')
  })

  it('7 日より先は出さない', () => {
    expect(bucketOfDue(new Date(boardDateTimeIso('2026-09-19', '09:00')), NOW)).toBeNull()
  })

  it('月をまたいでも崩れない', () => {
    // 月末の 23:59 に見ている。翌月へ入るぶんも「今週」で数える
    const monthEnd = new Date(boardDateTimeIso('2026-09-30', '23:59'))
    expect(bucketOfDue(new Date(boardDateTimeIso('2026-09-30', '23:58')), monthEnd)).toBe('overdue')
    expect(bucketOfDue(new Date(boardDateTimeIso('2026-10-01', '09:00')), monthEnd)).toBe('week')
    expect(bucketOfDue(new Date(boardDateTimeIso('2026-10-07', '23:00')), monthEnd)).toBe('week')
    expect(bucketOfDue(new Date(boardDateTimeIso('2026-10-08', '09:00')), monthEnd)).toBeNull()
  })

  it('年をまたいでも崩れない', () => {
    const yearEnd = new Date(boardDateTimeIso('2026-12-31', '23:00'))
    expect(bucketOfDue(new Date(boardDateTimeIso('2026-12-31', '23:30')), yearEnd)).toBe('today')
    expect(bucketOfDue(new Date(boardDateTimeIso('2027-01-01', '09:00')), yearEnd)).toBe('week')
  })

  it('日曜から月曜へまたいでも、区切りは曜日を見ていない', () => {
    // 「今週」は月曜起点の週ではなく「今日から 7 日」。日曜の夜に見ても、
    // 翌週の土曜まで同じように出る
    const sunday = new Date(boardDateTimeIso('2026-09-13', '20:00'))
    expect(bucketOfDue(new Date(boardDateTimeIso('2026-09-14', '09:00')), sunday)).toBe('week')
    expect(bucketOfDue(new Date(boardDateTimeIso('2026-09-19', '09:00')), sunday)).toBe('week')
  })
})

describe('bucketOfOccurrence', () => {
  const at = (date: string, time: string) => new Date(boardDateTimeIso(date, time))

  it('今日なら、もう始まっていても「今日」', () => {
    // 9 時の打ち合わせを 15 時に見ている。過ぎていても今日の顔ぶれに要る
    expect(bucketOfOccurrence(at('2026-09-11', '09:00'), at('2026-09-11', '10:00'), NOW)).toBe(
      'today',
    )
  })

  it('昨日で終わったものは出さない（予定に「期限切れ」は無い）', () => {
    expect(bucketOfOccurrence(at('2026-09-10', '09:00'), at('2026-09-10', '10:00'), NOW)).toBeNull()
  })

  it('昨日から明日まで続くものは「今日」', () => {
    // 8/1〜8/3 の旅行を 8/2 に見ている。始まりだけで区切ると、ここで消える
    expect(bucketOfOccurrence(at('2026-09-10', '09:00'), at('2026-09-12', '17:00'), NOW)).toBe(
      'today',
    )
  })

  it('終わりが無いものは、始まりで見る', () => {
    expect(bucketOfOccurrence(at('2026-09-11', '20:00'), null, NOW)).toBe('today')
    expect(bucketOfOccurrence(at('2026-09-10', '20:00'), null, NOW)).toBeNull()
  })

  it('今日の 0:00 ちょうどに終わる予定も「今日」に入れる', () => {
    /*
     * 半開区間にすれば「昨日の話」として落とせるが、そうしない。
     * カレンダー（groupOccurrencesByDay）が閉区間で、9/10 22:00〜9/11 00:00 の
     * 予定を 9/10 と 9/11 の両方に出しているため。ここだけ半開にすると、
     * カレンダーには今日の欄に出ているのにホームは数えない、という食い違いになる。
     *
     * 数え方を変えるなら、両方まとめて変えること。
     */
    expect(bucketOfOccurrence(at('2026-09-10', '22:00'), at('2026-09-11', '00:00'), NOW)).toBe(
      'today',
    )
  })

  it('明日から 7 日後までは「今週」', () => {
    expect(bucketOfOccurrence(at('2026-09-14', '09:00'), at('2026-09-14', '10:00'), NOW)).toBe(
      'week',
    )
  })

  it('7 日より先は出さない', () => {
    expect(bucketOfOccurrence(at('2026-09-30', '09:00'), at('2026-09-30', '10:00'), NOW)).toBeNull()
  })
})

describe('buildOverview', () => {
  it('ボードを跨いで、近いものから並ぶ', () => {
    const items = buildOverview(
      {
        rooms: ROOMS,
        todos: [
          makeTodo({ id: 't1', due_at: boardDateTimeIso('2026-09-12', '10:00'), title: '会場に連絡' }),
          makeTodo({
            id: 't2',
            room_id: 'r2',
            due_at: boardDateTimeIso('2026-09-11', '09:00'),
            title: '資料を送る',
          }),
        ],
        events: [],
        overrides: NO_OVERRIDES,
      },
      NOW,
    )

    expect(items.map((i) => i.title)).toEqual(['資料を送る', '会場に連絡'])
    expect(items[0].room.name).toBe('部会')
    expect(items[0].bucket).toBe('overdue')
    expect(items[1].bucket).toBe('week')
  })

  it('期限の無いやることは出さない', () => {
    const items = buildOverview(
      { rooms: ROOMS, todos: [makeTodo({ id: 't1', due_at: null })], events: [], overrides: NO_OVERRIDES },
      NOW,
    )
    expect(items).toEqual([])
  })

  it('参加していないボードの行は捨てる', () => {
    // RLS を通っていても、ホームの一覧に無いボードの行は名前を出せない
    const items = buildOverview(
      {
        rooms: ROOMS,
        todos: [makeTodo({ id: 't1', room_id: 'r9', due_at: boardDateTimeIso('2026-09-11', '09:00') })],
        events: [],
        overrides: NO_OVERRIDES,
      },
      NOW,
    )
    expect(items).toEqual([])
  })

  it('繰り返し予定は、今週ぶんの回だけが並ぶ', () => {
    const items = buildOverview(
      {
        rooms: ROOMS,
        todos: [],
        events: [
          makeEvent({
            id: 'e1',
            title: '朝会',
            recurrence: 'daily',
            start_at: boardDateTimeIso('2026-09-01', '09:00'),
            end_at: boardDateTimeIso('2026-09-01', '09:15'),
          }),
        ],
        overrides: NO_OVERRIDES,
      },
      NOW,
    )

    // 今日から 7 日後まで（今日を含めて 8 日ぶん）
    expect(items).toHaveLength(OVERVIEW_DAYS + 1)
    expect(items.every((i) => i.kind === 'event')).toBe(true)
    // 飛び先はどの回も元の 1 行
    expect(new Set(items.map((i) => i.targetId))).toEqual(new Set(['e1']))
    // key は回ごとに違う（同じだと画面が 1 行しか描かない）
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length)
  })

  it('ずっと前から続いている定例も、今週のぶんが出る', () => {
    /*
     * 3 か月前に作った毎週の定例。元の行の start_at は窓のはるか手前にあるので、
     * 「start_at が窓に入るもの」で候補を切ると 1 件も出なくなる。
     * 取ってくる側（MyOverview）が繰り返しを窓で切らないことと、
     * 展開の側が窓の頭まで飛ばして数えることの、両方が要る。
     */
    const items = buildOverview(
      {
        rooms: ROOMS,
        todos: [],
        events: [
          makeEvent({
            id: 'e1',
            title: '週次ミーティング',
            recurrence: 'weekly',
            start_at: boardDateTimeIso('2026-06-12', '10:00'),
            end_at: boardDateTimeIso('2026-06-12', '11:00'),
          }),
        ],
        overrides: NO_OVERRIDES,
      },
      NOW,
    )

    // 6/12 は金曜。9/11（金）と 9/18（金）の 2 回が窓に入る
    expect(items.map((i) => i.title)).toEqual(['週次ミーティング', '週次ミーティング'])
    expect(items[0].bucket).toBe('today')
    expect(items[1].bucket).toBe('week')
  })

  it('窓の外の回を「この回だけ」で今週へ動かしたら、出る', () => {
    /*
     * 10/2 の回を 9/13 に動かした。元の回は窓の外なので、素直に展開すると出ない。
     * expandOccurrences は最後に「動かした先が範囲に入るもの」を拾い直すので、
     * 取ってくる側が overrides を日付で絞っていなければここまで届く。
     */
    const items = buildOverview(
      {
        rooms: ROOMS,
        todos: [],
        events: [
          makeEvent({
            id: 'e1',
            title: '月次の点検',
            recurrence: 'weekly',
            start_at: boardDateTimeIso('2026-10-02', '10:00'),
            end_at: boardDateTimeIso('2026-10-02', '11:00'),
          }),
        ],
        overrides: [
          {
            id: 'o1',
            room_id: 'r1',
            event_id: 'e1',
            occurrence_date: '2026-10-02',
            canceled: false,
            title: null,
            description: null,
            start_at: boardDateTimeIso('2026-09-13', '14:00'),
            end_at: boardDateTimeIso('2026-09-13', '15:00'),
            all_day: null,
            color: null,
            remind_minutes: null,
            tags: null,
            author_id: 'u1',
            created_at: '2026-09-01T00:00:00.000Z',
          } as EventOverride,
        ],
      },
      NOW,
    )

    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('月次の点検')
    expect(items[0].bucket).toBe('week')
    // 飛び先は元の行のまま
    expect(items[0].targetId).toBe('e1')
  })

  it('「この回だけ」消した回は出ない', () => {
    const items = buildOverview(
      {
        rooms: ROOMS,
        todos: [],
        events: [
          makeEvent({
            id: 'e1',
            recurrence: 'daily',
            start_at: boardDateTimeIso('2026-09-01', '09:00'),
            end_at: boardDateTimeIso('2026-09-01', '09:15'),
          }),
        ],
        overrides: [
          {
            id: 'o1',
            room_id: 'r1',
            event_id: 'e1',
            occurrence_date: '2026-09-12',
            canceled: true,
            title: null,
            description: null,
            start_at: null,
            end_at: null,
            all_day: null,
            color: null,
            remind_minutes: null,
            tags: null,
            author_id: 'u1',
            created_at: '2026-09-01T00:00:00.000Z',
          } as EventOverride,
        ],
      },
      NOW,
    )
    expect(items).toHaveLength(OVERVIEW_DAYS)
  })
})

describe('countOverview', () => {
  it('4 つの数は重ならない（足すと件数に合う）', () => {
    const items = buildOverview(
      {
        rooms: ROOMS,
        todos: [
          makeTodo({ id: 't1', due_at: boardDateTimeIso('2026-09-10', '10:00') }), // 期限切れ
          makeTodo({ id: 't2', due_at: boardDateTimeIso('2026-09-11', '18:00') }), // 今日
          makeTodo({ id: 't3', due_at: boardDateTimeIso('2026-09-15', '10:00') }), // 今週
        ],
        events: [
          makeEvent({ id: 'e1', start_at: boardDateTimeIso('2026-09-11', '16:00') }), // 今日
          makeEvent({ id: 'e2', start_at: boardDateTimeIso('2026-09-13', '16:00') }), // 今週
        ],
        overrides: NO_OVERRIDES,
      },
      NOW,
    )

    const counts = countOverview(items)
    expect(counts).toEqual({ overdue: 1, todayTodo: 1, todayEvent: 1, week: 2 })
    expect(counts.overdue + counts.todayTodo + counts.todayEvent + counts.week).toBe(items.length)
  })

  it('空でも落ちない', () => {
    expect(countOverview([])).toEqual({ overdue: 0, todayTodo: 0, todayEvent: 0, week: 0 })
  })
})
