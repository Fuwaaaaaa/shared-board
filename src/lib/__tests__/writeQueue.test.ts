import { describe, expect, it } from 'vitest'
import {
  classifyError,
  collapse,
  decideOnFailure,
  identityChanged,
  isTransportError,
  keyOf,
  lockedFields,
  MAX_ATTEMPTS,
  nextBackoff,
  nullOrphanRefs,
  orderForFlush,
  previewOf,
  tooLargeToQueue,
  type QueueEntry,
  type QueueOp,
} from '../writeQueue'

function makeOp(over: Partial<QueueOp> = {}): QueueOp {
  return {
    roomId: 'room-1',
    table: 'notes',
    rowId: 'note-1',
    userId: 'me',
    kind: 'create',
    label: '付箋',
    preview: '合宿の持ち物',
    seq: 1,
    ...over,
  }
}

function makeEntry(over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    key: keyOf('room-1', 'notes', 'note-1'),
    roomId: 'room-1',
    table: 'notes',
    rowId: 'note-1',
    userId: 'me',
    kind: 'create',
    label: '付箋',
    preview: '合宿の持ち物',
    seq: 1,
    enqueuedAt: '2026-09-08T00:00:00.000Z',
    state: 'pending',
    attempts: 0,
    ...over,
  }
}

describe('collapse', () => {
  /*
   * 操作のログを再生せず、行ごとの最終状態だけを持つ。
   * ここが崩れると、オフラインで直した回数だけリクエストが飛ぶ。
   */
  it('はじめての create は、そのまま行を持つ', () => {
    const entry = collapse(undefined, makeOp({ row: { id: 'note-1', text: 'あ' } }))
    expect(entry).toMatchObject({ kind: 'create', row: { text: 'あ' } })
  })

  it('create のあとの update は、1 件の create に畳まれる', () => {
    const created = collapse(undefined, makeOp({ row: { id: 'note-1', text: 'あ' } }))!
    const entry = collapse(created, makeOp({ kind: 'update', patch: { text: 'いろは' } }))!
    expect(entry.kind).toBe('create')
    expect(entry.row).toMatchObject({ id: 'note-1', text: 'いろは' })
  })

  it('create のあとの delete は、まるごと捨てる（1 件も送らない）', () => {
    const created = collapse(undefined, makeOp({ row: { id: 'note-1', text: 'あ' } }))!
    expect(collapse(created, makeOp({ kind: 'delete' }))).toBeNull()
  })

  it('update を重ねると、列ごとに新しいほうが残る', () => {
    const first = collapse(
      undefined,
      makeOp({ kind: 'update', patch: { text: 'あ', x: 10 }, base: { text: '', x: 0 } }),
    )!
    const entry = collapse(
      first,
      makeOp({ kind: 'update', patch: { text: 'いろは', y: 20 }, base: { text: 'あ', y: 0 } }),
    )!
    expect(entry.patch).toEqual({ text: 'いろは', x: 10, y: 20 })
  })

  it('取り消しの戻り先は、いちばん最初の値のまま', () => {
    const first = collapse(
      undefined,
      makeOp({ kind: 'update', patch: { text: 'あ' }, base: { text: 'もとの文' } }),
    )!
    const entry = collapse(
      first,
      makeOp({ kind: 'update', patch: { text: 'いろは' }, base: { text: 'あ' } }),
    )!
    expect(entry.base).toEqual({ text: 'もとの文' })
  })

  it('update のあとの delete は delete になり、戻り先は保つ', () => {
    const first = collapse(
      undefined,
      makeOp({ kind: 'update', patch: { text: 'あ' }, base: { text: 'もとの文' } }),
    )!
    const entry = collapse(first, makeOp({ kind: 'delete' }))!
    expect(entry.kind).toBe('delete')
    expect(entry.base).toEqual({ text: 'もとの文' })
  })

  it('12 回直しても、送るのは 1 件', () => {
    let entry = collapse(undefined, makeOp({ row: { id: 'note-1', text: '0' } }))
    for (let i = 1; i <= 12; i++) {
      entry = collapse(entry ?? undefined, makeOp({ kind: 'update', patch: { text: String(i) } }))
    }
    expect(entry).toMatchObject({ kind: 'create' })
    expect((entry!.row as { text: string }).text).toBe('12')
  })

  it('最初にためた時刻と順番は保つ', () => {
    const created = collapse(undefined, makeOp({ seq: 5 }))!
    const entry = collapse(created, makeOp({ kind: 'update', patch: { text: 'あ' }, seq: 99 }))!
    expect(entry.seq).toBe(5)
    expect(entry.enqueuedAt).toBe(created.enqueuedAt)
  })
})

describe('orderForFlush', () => {
  /*
   * todos.source_note_id / source_event_id は本物の外部キー。
   * 子が先に行くと 23503 で弾かれる。
   */
  it('親の表から先に送る', () => {
    const entries = [
      makeEntry({ table: 'comments', rowId: 'c1', key: 'k1', seq: 1 }),
      makeEntry({ table: 'todos', rowId: 't1', key: 'k2', seq: 1 }),
      makeEntry({ table: 'notes', rowId: 'n1', key: 'k3', seq: 1 }),
      makeEntry({ table: 'events', rowId: 'e1', key: 'k4', seq: 1 }),
    ]
    expect(orderForFlush(entries).map((e) => e.table)).toEqual([
      'notes',
      'events',
      'todos',
      'comments',
    ])
  })

  it('同じ表の中は、ためた順', () => {
    const entries = [
      makeEntry({ rowId: 'n2', key: 'k2', seq: 20 }),
      makeEntry({ rowId: 'n1', key: 'k1', seq: 10 }),
    ]
    expect(orderForFlush(entries).map((e) => e.seq)).toEqual([10, 20])
  })

  it('元の配列は変えない', () => {
    const entries = [
      makeEntry({ table: 'todos', key: 'k1', seq: 1 }),
      makeEntry({ table: 'notes', key: 'k2', seq: 1 }),
    ]
    orderForFlush(entries)
    expect(entries[0].table).toBe('todos')
  })
})

describe('nullOrphanRefs', () => {
  it('送れなかった親を指す列だけを null にする', () => {
    const row = { id: 't1', title: '買い出し', source_note_id: 'n-gone', source_event_id: 'e-ok' }
    expect(nullOrphanRefs(row, new Set(['n-gone']))).toEqual({
      id: 't1',
      title: '買い出し',
      source_note_id: null,
      source_event_id: 'e-ok',
    })
  })

  it('親が全部いれば、そのまま', () => {
    const row = { id: 't1', source_note_id: 'n1' }
    expect(nullOrphanRefs(row, new Set())).toEqual(row)
  })

  it('元の行は変えない', () => {
    const row = { id: 't1', source_note_id: 'n-gone' }
    nullOrphanRefs(row, new Set(['n-gone']))
    expect(row.source_note_id).toBe('n-gone')
  })
})

describe('classifyError', () => {
  /*
   * 主キーの重複は「前回が実は通っていた」ので成功。これが二重送信を安全にしている。
   * ただし todos には主キー以外の部分一意インデックスがあるので、
   * 23505 を一括りにすると別物の行を握り潰す。
   */
  it('主キーの重複は成功として扱う', () => {
    expect(
      classifyError({
        code: '23505',
        message: 'duplicate key value violates unique constraint "notes_pkey"',
        details: 'Key (id)=(note-1) already exists.',
      }),
    ).toEqual({ outcome: 'success' })
  })

  it('主キー以外の重複は、送れなかったものとして残す', () => {
    const result = classifyError({
      code: '23505',
      message: 'duplicate key value violates unique constraint "todos_next_occurrence_uidx"',
      details: 'Key (source_todo_id)=(t1) already exists.',
    })
    expect(result).toMatchObject({ outcome: 'dead', reason: 'duplicate' })
  })

  it('権限', () => {
    expect(classifyError({ code: '42501', message: 'permission denied' })).toMatchObject({
      outcome: 'dead',
      reason: 'permission',
    })
  })

  it('親がもういない', () => {
    expect(classifyError({ code: '23503', message: 'violates foreign key' })).toMatchObject({
      outcome: 'dead',
      reason: 'parent_gone',
    })
  })

  it('件数の上限と文字数の上限は見分ける', () => {
    expect(
      classifyError({ code: '23514', message: '付箋 はボードあたり 2000 件までです' }),
    ).toMatchObject({ outcome: 'dead', reason: 'full' })
    expect(classifyError({ code: '23514', message: 'text は 5000 文字までです' })).toMatchObject({
      outcome: 'dead',
      reason: 'too_long',
    })
  })

  it('サーバーの文言はそのまま持つ（言い換えない）', () => {
    const result = classifyError({ code: '23514', message: '付箋 はボードあたり 2000 件までです' })
    expect(result).toMatchObject({ errorText: '付箋 はボードあたり 2000 件までです' })
  })

  it('通信の失敗と 5xx・429 は、もう一度試す', () => {
    expect(classifyError({ message: 'TypeError: Failed to fetch' })).toEqual({ outcome: 'retry' })
    expect(classifyError({ status: 503, message: 'unavailable' })).toEqual({ outcome: 'retry' })
    expect(classifyError({ status: 429, message: 'too many' })).toEqual({ outcome: 'retry' })
  })

  it('知らない失敗は、理由を付けて残す', () => {
    expect(classifyError({ code: 'XX000', message: 'なにか' })).toMatchObject({
      outcome: 'dead',
      reason: 'unknown',
      errorText: 'なにか',
    })
  })
})

describe('decideOnFailure', () => {
  it('通信が届かなかったときは、ためる', () => {
    expect(decideOnFailure({ message: 'TypeError: Failed to fetch' })).toBe('queue')
    expect(decideOnFailure({ isTransport: true })).toBe('queue')
  })

  it('サーバーの一時的な失敗も、ためる', () => {
    expect(decideOnFailure({ status: 502, message: 'bad gateway' })).toBe('queue')
  })

  it('権限や決まりの違反は、ためずにその場で失敗にする', () => {
    expect(decideOnFailure({ code: '42501', status: 403, message: 'denied' })).toBe('fail')
    expect(decideOnFailure({ code: '23514', message: '5000 文字までです' })).toBe('fail')
  })
})

describe('isTransportError', () => {
  it('印が付いていれば通信の失敗', () => {
    expect(isTransportError({ isTransport: true })).toBe(true)
  })

  it('supabase-js が潰した文言からも見分ける', () => {
    // 投げた fetch のエラーは { message: 'TypeError: Failed to fetch' } に潰される
    expect(isTransportError({ message: 'TypeError: Failed to fetch' })).toBe(true)
    expect(isTransportError({ message: 'NetworkError when attempting to fetch' })).toBe(true)
    expect(isTransportError({ message: 'Load failed' })).toBe(true)
  })

  it('ふつうのエラーは違う', () => {
    expect(isTransportError({ code: '42501', message: 'permission denied' })).toBe(false)
  })
})

describe('lockedFields', () => {
  /*
   * 文字と意味を持つ列だけロックする。位置や色に掛けると譲り合いになって
   * 動かせなくなる（もとからの方針）。
   */
  it('付箋は本文とタグ', () => {
    expect(lockedFields('notes', { text: 'あ', x: 10 })).toEqual(['text'])
    expect(lockedFields('notes', { text: 'あ', tags: [] })).toEqual(['text', 'tags'])
  })

  it('位置や色だけならロックしない', () => {
    expect(lockedFields('notes', { x: 10, y: 20, color: 'blue', z: 3 })).toEqual([])
  })

  it('予定は、サーバーが updated_at を進める列と同じ', () => {
    expect(lockedFields('events', { title: 'あ', start_at: 'x', color: 'blue' })).toEqual([
      'title',
      'start_at',
    ])
  })

  it('やることの done や status はロックしない', () => {
    expect(lockedFields('todos', { done: true, status: 'done', sort_order: 1 })).toEqual([])
  })
})

describe('nextBackoff', () => {
  it('だんだん長くなる', () => {
    expect(nextBackoff(0)).toBe(1_000)
    expect(nextBackoff(1)).toBe(2_000)
    expect(nextBackoff(2)).toBe(5_000)
  })

  it('5 分で頭打ち', () => {
    expect(nextBackoff(5)).toBe(300_000)
    expect(nextBackoff(50)).toBe(300_000)
  })

  it('試す回数には上限がある', () => {
    expect(MAX_ATTEMPTS).toBeGreaterThan(0)
  })
})

describe('identityChanged', () => {
  it('ブラウザのデータを消して別人になったら、もう送れない', () => {
    expect(identityChanged(makeEntry({ userId: 'me' }), 'someone-else')).toBe(true)
    expect(identityChanged(makeEntry({ userId: 'me' }), 'me')).toBe(false)
  })
})

describe('previewOf', () => {
  it('1 行目だけを取る', () => {
    expect(previewOf('合宿の持ち物\n寝袋\nタオル')).toBe('合宿の持ち物')
  })

  it('長いものは切って … を付ける', () => {
    expect(previewOf('あ'.repeat(100))).toBe(`${'あ'.repeat(80)}…`)
  })

  it('文字でなければ空', () => {
    expect(previewOf(undefined)).toBe('')
    expect(previewOf(123)).toBe('')
  })
})

describe('tooLargeToQueue', () => {
  it('ふつうの付箋は入る', () => {
    expect(tooLargeToQueue(makeEntry({ row: { text: 'あ'.repeat(1000) } }))).toBe(false)
  })

  it('大きすぎるものは、ためずに断る（黙って落とさない）', () => {
    expect(tooLargeToQueue(makeEntry({ row: { points: 'x'.repeat(500_000) } }))).toBe(true)
  })
})
