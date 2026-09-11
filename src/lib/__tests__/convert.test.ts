import { describe, expect, it } from 'vitest'
import {
  acknowledgeOrigin,
  buildEvent,
  buildTodo,
  defaultStart,
  eventFromNote,
  eventPatchFromNote,
  originChanged,
  splitNoteText,
  todoFromEvent,
  todoFromNote,
  todoPatchFromEvent,
  todoPatchFromNote,
} from '../convert'
import type { Author } from '../convert'
import type { CalendarEvent, Note } from '../types'

/*
 * 付箋 → やること → 予定 の組み立て。
 *
 * このアプリの本筋（話したことが、そのまま予定とやることになる）を通す部分で、
 * ホワイトボードとカレンダーの両方から呼ばれる。間違えても画面には
 * 「それらしいもの」が出てしまうので、ここで形を固めておく。
 */

const author: Author = { userId: 'user-1', displayName: 'ゆうき' }

function makeNote(over: Partial<Note> = {}): Note {
  return {
    id: 'note-1',
    room_id: 'room-1',
    kind: 'sticky',
    x: 0,
    y: 0,
    w: 200,
    h: 200,
    color: 'yellow',
    text: '会場を押さえる',
    tags: [],
    z: 1,
    font_size: 0,
    deleted_at: null,
    author_id: 'user-9',
    author_name: 'けいこ',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  }
}

function makeEvent(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'event-1',
    room_id: 'room-1',
    kind: 'event',
    title: '合宿',
    description: '体育館を借りる',
    start_at: '2026-10-01T01:00:00.000Z',
    end_at: null,
    all_day: false,
    color: 'blue',
    recurrence: 'none',
    recurrence_days: [],
    recurrence_week: null,
    recurrence_interval: null,
    recurrence_until: null,
    remind_minutes: 60,
    tags: ['合宿'],
    source_note_id: null,
    source_synced_at: null,
    deleted_at: null,
    author_id: 'user-9',
    author_name: 'けいこ',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  }
}

describe('splitNoteText', () => {
  it('最初の中身のある行がタイトル、残りがメモ', () => {
    expect(splitNoteText('会場を押さえる\n体育館\n鍵は事務室')).toEqual({
      title: '会場を押さえる',
      body: '体育館\n鍵は事務室',
    })
  })

  it('先頭の空行は飛ばす（付箋は改行から書き始められる）', () => {
    expect(splitNoteText('\n\n  会場を押さえる  \n体育館')).toEqual({
      title: '会場を押さえる',
      body: '体育館',
    })
  })

  it('中身が無ければタイトルは空。呼び出し側で弾く合図になる', () => {
    expect(splitNoteText('')).toEqual({ title: '', body: '' })
    expect(splitNoteText('\n \n\t\n')).toEqual({ title: '', body: '' })
  })

  it('1 行だけならメモは空', () => {
    expect(splitNoteText('会場を押さえる')).toEqual({ title: '会場を押さえる', body: '' })
  })

  it('改行が CRLF でも同じ（貼り付けで混ざる）', () => {
    expect(splitNoteText('会場を押さえる\r\n体育館')).toEqual({
      title: '会場を押さえる',
      body: '体育館',
    })
  })

  it('DB の上限に合わせて切る（タイトル 120 / メモ 500）', () => {
    const { title, body } = splitNoteText(`${'あ'.repeat(200)}\n${'い'.repeat(600)}`)
    expect(title).toHaveLength(120)
    expect(body).toHaveLength(500)
  })
})

describe('buildTodo', () => {
  it('期限が無ければ、事前通知は落とす', () => {
    // 期限のないやることに「15 分前」だけ残ると、いつの 15 分前か決まらない
    const todo = buildTodo({ roomId: 'room-1', author, title: '買い出し', remindMinutes: 15 })
    expect(todo.due_at).toBeNull()
    expect(todo.remind_minutes).toBeNull()
  })

  it('期限があれば、事前通知はそのまま残る', () => {
    const todo = buildTodo({
      roomId: 'room-1',
      author,
      title: '買い出し',
      dueAt: '2026-10-01T01:00:00.000Z',
      remindMinutes: 15,
    })
    expect(todo.remind_minutes).toBe(15)
  })

  it('作った人は「いま操作している人」で、もとの付箋を書いた人ではない', () => {
    const todo = buildTodo({ roomId: 'room-1', author, title: '買い出し' })
    expect(todo.author_id).toBe('user-1')
    expect(todo.author_name).toBe('ゆうき')
  })

  it('残りの既定値は、未着手・繰り返しなし・空のサブタスク', () => {
    const todo = buildTodo({ roomId: 'room-1', author, title: '買い出し' })
    expect(todo).toMatchObject({
      done: false,
      done_at: null,
      status: 'todo',
      recurrence: 'none',
      subtasks: [],
      tags: [],
      deleted_at: null,
      assignee_id: null,
      assignee_name: '',
    })
  })

  it('タイトルは 120 文字で切る', () => {
    const todo = buildTodo({ roomId: 'room-1', author, title: 'あ'.repeat(200) })
    expect(todo.title).toHaveLength(120)
  })
})

describe('buildEvent', () => {
  it('既定は終日。時刻を決めていない付箋から作るとここに落ちる', () => {
    const event = buildEvent({
      roomId: 'room-1',
      author,
      title: '合宿',
      startAt: '2026-10-01T00:00:00.000Z',
    })
    expect(event.all_day).toBe(true)
    expect(event.kind).toBe('event')
    expect(event.color).toBe('blue')
  })

  it('タイトルは 100 文字で切る（やることの 120 とは違う）', () => {
    const event = buildEvent({
      roomId: 'room-1',
      author,
      title: 'あ'.repeat(200),
      startAt: '2026-10-01T00:00:00.000Z',
    })
    expect(event.title).toHaveLength(100)
  })
})

describe('付箋から作る', () => {
  it('やること — 1 行目がタイトル、残りがメモになる', () => {
    const todo = todoFromNote(makeNote({ text: '会場を押さえる\n体育館' }), 'room-2', author)
    expect(todo.title).toBe('会場を押さえる')
    expect(todo.notes).toBe('体育館')
    expect(todo.room_id).toBe('room-2')
  })

  it('やること — どの付箋から生まれたかと、そのときの版を控える', () => {
    const note = makeNote({ id: 'note-9', updated_at: '2026-09-05T00:00:00.000Z' })
    const todo = todoFromNote(note, 'room-1', author)
    expect(todo.source_note_id).toBe('note-9')
    expect(todo.source_synced_at).toBe('2026-09-05T00:00:00.000Z')
  })

  it('やること — 付箋のタグを引き継ぐ', () => {
    const todo = todoFromNote(makeNote({ tags: ['合宿', '準備'] }), 'room-1', author)
    expect(todo.tags).toEqual(['合宿', '準備'])
  })

  it('予定 — 開始時刻と終日かどうかは、呼び出し側が決める', () => {
    const event = eventFromNote(
      makeNote({ text: '合宿\n体育館' }),
      'room-1',
      author,
      '2026-10-01T01:00:00.000Z',
      false,
    )
    expect(event.title).toBe('合宿')
    expect(event.description).toBe('体育館')
    expect(event.start_at).toBe('2026-10-01T01:00:00.000Z')
    expect(event.all_day).toBe(false)
    expect(event.source_note_id).toBe('note-1')
  })
})

describe('todoFromEvent', () => {
  it('予定の開始が、やることの期限になる', () => {
    const todo = todoFromEvent(makeEvent(), 'room-1', author)
    expect(todo.due_at).toBe('2026-10-01T01:00:00.000Z')
    expect(todo.title).toBe('合宿')
    expect(todo.notes).toBe('体育館を借りる')
  })

  it('もとが予定なので、控えるのは source_event_id のほう', () => {
    const todo = todoFromEvent(makeEvent({ id: 'event-9' }), 'room-1', author)
    expect(todo.source_event_id).toBe('event-9')
    expect(todo.source_note_id).toBeNull()
  })

  it('予定に事前通知が無ければ、やること側は 0（＝時刻ちょうど）', () => {
    const todo = todoFromEvent(makeEvent({ remind_minutes: null }), 'room-1', author)
    expect(todo.remind_minutes).toBe(0)
  })
})

describe('originChanged', () => {
  const item = { source_synced_at: '2026-09-01T00:00:00.000Z' }

  it('もとが後から変わっていれば true', () => {
    expect(originChanged(item, { updated_at: '2026-09-02T00:00:00.000Z' })).toBe(true)
  })

  it('同じ時刻なら false（取り込んだあと触られていない）', () => {
    expect(originChanged(item, { updated_at: '2026-09-01T00:00:00.000Z' })).toBe(false)
  })

  it('もとが消えていれば false（お知らせを出しても戻る先が無い）', () => {
    expect(originChanged(item, null)).toBe(false)
    expect(originChanged(item, undefined)).toBe(false)
  })

  it('取り込んでいないものは false', () => {
    expect(originChanged({ source_synced_at: null }, { updated_at: '2026-09-02T00:00:00.000Z' })).toBe(
      false,
    )
  })
})

describe('「反映する」で書き戻す内容', () => {
  it('やること — タイトルとメモを入れ替え、控えの版を進める', () => {
    const note = makeNote({ text: '会場を押さえる\n体育館', updated_at: '2026-09-06T00:00:00.000Z' })
    expect(todoPatchFromNote(note)).toEqual({
      title: '会場を押さえる',
      notes: '体育館',
      source_synced_at: '2026-09-06T00:00:00.000Z',
    })
  })

  it('予定 — タイトルの上限がやること（120）と違って 100', () => {
    const note = makeNote({ text: 'あ'.repeat(200) })
    expect(todoPatchFromNote(note).title).toHaveLength(120)
    expect(eventPatchFromNote(note).title).toHaveLength(100)
  })

  it('予定 → やること — 期限も予定の開始に合わせ直す', () => {
    const event = makeEvent({
      start_at: '2026-11-03T02:00:00.000Z',
      updated_at: '2026-09-07T00:00:00.000Z',
    })
    expect(todoPatchFromEvent(event)).toEqual({
      title: '合宿',
      notes: '体育館を借りる',
      due_at: '2026-11-03T02:00:00.000Z',
      source_synced_at: '2026-09-07T00:00:00.000Z',
    })
  })

  it('「このままにする」は、控えの版だけを進める', () => {
    expect(acknowledgeOrigin({ updated_at: '2026-09-07T00:00:00.000Z' })).toEqual({
      source_synced_at: '2026-09-07T00:00:00.000Z',
    })
  })
})

describe('defaultStart', () => {
  it('その日の 9:00 ちょうど（ボードの暦は Asia/Tokyo）', () => {
    const start = defaultStart(new Date('2026-10-01T15:43:21.987+09:00'))
    expect(start.getHours()).toBe(9)
    expect(start.getMinutes()).toBe(0)
    expect(start.getSeconds()).toBe(0)
    expect(start.getMilliseconds()).toBe(0)
    expect(start.getDate()).toBe(1)
  })

  it('渡した日付そのものは変えない', () => {
    const now = new Date('2026-10-01T15:43:21.987+09:00')
    defaultStart(now)
    expect(now.getHours()).toBe(15)
  })
})
