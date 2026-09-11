import { afterEach, describe, expect, it, vi } from 'vitest'
import { foldForSearch, searchRoom, type SearchInput } from '../search'
import type { CalendarEvent, Comment, Note, Todo } from '../types'

function note(over: Partial<Note> = {}): Note {
  return {
    id: 'note-1',
    room_id: 'room',
    kind: 'sticky',
    x: 0,
    y: 0,
    w: 220,
    h: 170,
    color: 'yellow',
    text: 'メモ',
    tags: [],
    z: 0,
    font_size: 0,
    deleted_at: null,
    author_id: 'me',
    author_name: 'わたし',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'event-1',
    room_id: 'room',
    kind: 'event',
    title: '打ち合わせ',
    description: '',
    start_at: '2026-09-01T01:00:00.000Z',
    end_at: null,
    all_day: false,
    color: 'blue',
    recurrence: 'none',
    recurrence_until: null,
    remind_minutes: null,
    tags: [],
    source_note_id: null,
    source_synced_at: null,
    deleted_at: null,
    author_id: 'me',
    author_name: 'わたし',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  } as CalendarEvent
}

function todo(over: Partial<Todo> = {}): Todo {
  return {
    id: 'todo-1',
    room_id: 'room',
    title: '買い出し',
    notes: '',
    due_at: null,
    done: false,
    done_at: null,
    assignee_id: null,
    assignee_name: '',
    remind_minutes: null,
    recurrence: 'none',
    subtasks: [],
    tags: [],
    status: 'todo',
    sort_order: 0,
    source_note_id: null,
    source_event_id: null,
    source_synced_at: null,
    source_todo_id: null,
    deleted_at: null,
    author_id: 'me',
    author_name: 'わたし',
    created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  } as Todo
}

function comment(over: Partial<Comment> = {}): Comment {
  return {
    id: 'comment-1',
    room_id: 'room',
    target_type: 'note',
    target_id: 'note-1',
    body: 'いいですね',
    author_id: 'me',
    author_name: 'わたし',
    created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  } as Comment
}

function input(over: Partial<SearchInput> = {}): SearchInput {
  return {
    notes: [],
    events: [],
    todos: [],
    comments: [],
    images: [],
    attachments: [],
    frames: [],
    ...over,
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('foldForSearch（比べるための形に均す）', () => {
  it('半角カナ・全角英数・大文字小文字・カタカナを畳む', () => {
    expect(foldForSearch('ｶﾞｯｺｳ')).toBe('がっこう')
    expect(foldForSearch('ガッコウ')).toBe('がっこう')
    expect(foldForSearch('がっこう')).toBe('がっこう')
    expect(foldForSearch('ＡＢＣ')).toBe('abc')
    expect(foldForSearch('Meeting')).toBe('meeting')
  })

  it('長音符はそのまま残る（ひらがなにもカタカナにも効く）', () => {
    expect(foldForSearch('コーヒー')).toBe('こーひー')
  })
})

describe('searchRoom — 順位付け', () => {
  it('タイトル完全一致 > 前方一致 > 部分一致 > 本文 の順に並ぶ', () => {
    const hits = searchRoom('会議', {
      ...input(),
      events: [
        event({ id: 'body', title: '無関係', description: '会議のあとに' }),
        event({ id: 'part', title: '定例の会議です' }),
        event({ id: 'prefix', title: '会議の準備' }),
        event({ id: 'exact', title: '会議' }),
      ],
    })

    expect(hits.map((h) => h.targetId)).toEqual(['exact', 'prefix', 'part', 'body'])
  })

  it('タイトルが完全一致した予定は、部分一致の付箋より上に来る', () => {
    const hits = searchRoom('合宿', {
      ...input(),
      notes: [note({ id: 'n', text: '合宿のしおりを作る' })],
      events: [event({ id: 'e', title: '合宿' })],
    })

    expect(hits[0].kind).toBe('event')
  })

  it('完了したやることは下がるが、消えはしない', () => {
    const hits = searchRoom('買い出し', {
      ...input(),
      todos: [todo({ id: 'done', done: true }), todo({ id: 'open', done: false })],
    })

    expect(hits.map((h) => h.targetId)).toEqual(['open', 'done'])
    expect(hits).toHaveLength(2)
  })

  it('同点なら新しい順、それも同じなら毎回同じ並びになる', () => {
    const data = {
      ...input(),
      notes: [
        note({ id: 'old', text: 'あああ', updated_at: '2026-01-01T00:00:00.000Z' }),
        note({ id: 'new', text: 'あああ', updated_at: '2026-05-01T00:00:00.000Z' }),
      ],
    }
    expect(searchRoom('あああ', data).map((h) => h.targetId)).toEqual(['new', 'old'])
    // 2 回呼んでも同じ
    expect(searchRoom('あああ', data).map((h) => h.targetId)).toEqual(['new', 'old'])
  })
})

describe('searchRoom — 打ち切りが種別に偏らない', () => {
  it('付箋が 60 件当たっても、タイトル完全一致の予定が結果に残る', () => {
    // 以前は種別ブロックを連結したあとに 50 件で切っていたため、
    // 付箋が 50 件当たると予定・やること・コメントが 1 件も出なかった
    const many = Array.from({ length: 60 }, (_, i) =>
      note({ id: `n${i}`, text: `打ち合わせの下書き ${i}` }),
    )
    const hits = searchRoom('打ち合わせ', {
      ...input(),
      notes: many,
      events: [event({ id: 'e', title: '打ち合わせ' })],
    })

    expect(hits).toHaveLength(50)
    expect(hits[0].kind).toBe('event')
    expect(hits.some((h) => h.targetId === 'e')).toBe(true)
  })
})

describe('searchRoom — 当たり方', () => {
  it('表記が違っても当たる', () => {
    const data = { ...input(), notes: [note({ text: 'がっこうの用事' })] }
    for (const q of ['がっこう', 'ガッコウ', 'ｶﾞｯｺｳ']) {
      expect(searchRoom(q, data), q).toHaveLength(1)
    }
  })

  it('タグは # あり・なしどちらでも当たり、完全一致のほうが強い', () => {
    const hits = searchRoom('買い物', {
      ...input(),
      notes: [
        note({ id: 'part', text: '', tags: ['買い物リスト'] }),
        note({ id: 'exact', text: '', tags: ['買い物'] }),
      ],
    })
    expect(hits.map((h) => h.targetId)).toEqual(['exact', 'part'])
    expect(searchRoom('#買い物', { ...input(), notes: [note({ tags: ['買い物'] })] })).toHaveLength(1)
  })

  it('やることはサブタスク・担当者・作者名でも当たる', () => {
    expect(
      searchRoom('牛乳', { ...input(), todos: [todo({ subtasks: [{ id: 's', title: '牛乳', done: false }] })] }),
    ).toHaveLength(1)
    expect(searchRoom('たろう', { ...input(), todos: [todo({ assignee_name: 'たろう' })] })).toHaveLength(1)
    // 以前は付箋・予定だけが作者名で当たり、やることは担当者しか見ていなかった
    expect(searchRoom('わたし', { ...input(), todos: [todo()] })).toHaveLength(1)
  })

  it('空のクエリ・空白だけなら何も返さない', () => {
    const data = { ...input(), notes: [note()] }
    expect(searchRoom('', data)).toEqual([])
    expect(searchRoom('   ', data)).toEqual([])
  })
})

describe('searchRoom — 幽霊ヒットを出さない', () => {
  it('消した付箋に付いたコメントは出さない', () => {
    // notes/events/todos はゴミ箱を除いた一覧が渡ってくるが、
    // comments は除外を通っていないので、対象の生死をここで確かめる
    const hits = searchRoom('いいですね', {
      ...input(),
      notes: [],
      comments: [comment({ target_id: 'note-1' })],
    })
    expect(hits).toEqual([])
  })

  it('生きている付箋に付いたコメントは出す', () => {
    const hits = searchRoom('いいですね', {
      ...input(),
      notes: [note({ id: 'note-1' })],
      comments: [comment({ target_id: 'note-1' })],
    })
    expect(hits).toHaveLength(1)
    expect(hits[0].kind).toBe('comment')
  })

  it('チャット（対象を持たないコメント）は常に出す', () => {
    const hits = searchRoom('いいですね', {
      ...input(),
      comments: [comment({ target_type: 'board', target_id: null })],
    })
    expect(hits).toHaveLength(1)
    expect(hits[0].subtitle).toContain('チャット')
  })

  /*
   * 画像・ファイル・フレームにもコメントできる。
   * 生きているかを見る一覧に足し忘れると、この 3 種のコメントが
   * 「対象がもう無い」と判定されて、検索から丸ごと消える。
   */
  it('画像・ファイル・フレームへのコメントも、対象が生きていれば出す', () => {
    const cases = [
      { target_type: 'image' as const, key: 'images' as const, label: '画像' },
      { target_type: 'file' as const, key: 'attachments' as const, label: 'ファイル' },
      { target_type: 'frame' as const, key: 'frames' as const, label: 'フレーム' },
    ]

    for (const { target_type, key, label } of cases) {
      const hits = searchRoom('いいですね', {
        ...input(),
        [key]: [{ id: 'x1' }],
        comments: [comment({ target_type, target_id: 'x1' })],
      })
      expect(hits, label).toHaveLength(1)
      expect(hits[0].subtitle).toContain(`${label}へのコメント`)
      // 画像・ファイル・フレームはボードの上にあるので、飛び先はホワイトボード
      expect(hits[0].tab).toBe('board')
    }
  })

  it('消えた画像・ファイル・フレームへのコメントは出さない', () => {
    for (const target_type of ['image', 'file', 'frame'] as const) {
      const hits = searchRoom('いいですね', {
        ...input(),
        comments: [comment({ target_type, target_id: 'gone' })],
      })
      expect(hits, target_type).toEqual([])
    }
  })
})

describe('searchRoom — 日付はボードの暦（JST）で出す', () => {
  it('予定の日付が閲覧者のタイムゾーンに左右されない', () => {
    // 2026-09-01T01:00Z = JST 10:00 → 9/1(火)
    const hits = searchRoom('打ち合わせ', {
      ...input(),
      events: [event({ start_at: '2026-09-01T01:00:00.000Z' })],
    })
    expect(hits[0].subtitle).toBe('2026/9/1(火)')
  })

  it('日付が変わる境目でも JST で判定する', () => {
    // 2026-08-31T15:00Z = JST 9/1 0:00
    const hits = searchRoom('打ち合わせ', {
      ...input(),
      events: [event({ start_at: '2026-08-31T15:00:00.000Z' })],
    })
    expect(hits[0].subtitle).toBe('2026/9/1(火)')
  })

  it('実行環境のタイムゾーンを変えても結果が変わらない', () => {
    vi.stubEnv('TZ', 'America/New_York')
    // stub が効いていることの確認（NY は UTC-4/-5）
    expect(new Date('2026-09-01T00:00:00Z').getTimezoneOffset()).not.toBe(-540)

    const hits = searchRoom('打ち合わせ', {
      ...input(),
      events: [event({ start_at: '2026-08-31T15:00:00.000Z' })],
      todos: [todo({ title: '打ち合わせの準備', due_at: '2026-08-31T15:00:00.000Z' })],
    })
    expect(hits.find((h) => h.kind === 'event')?.subtitle).toBe('2026/9/1(火)')
    expect(hits.find((h) => h.kind === 'todo')?.subtitle).toBe('期限 9/1(火) 00:00')
  })
})
