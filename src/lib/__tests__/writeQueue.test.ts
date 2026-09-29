import { describe, expect, it } from 'vitest'
import {
  afterSend,
  alreadyApplied,
  classifyError,
  collapse,
  decideOnFailure,
  identityChanged,
  isTransportError,
  keyOf,
  lockedFields,
  MAX_ATTEMPTS,
  nextBackoff,
  nextRetryState,
  nullOrphanRefs,
  orderForFlush,
  previewOf,
  retryPatch,
  tooLargeToQueue,
  type QueueEntry,
  type QueueOp,
  withStatus,
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
    rev: 1,
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

  /*
   * 作成が実は前に届いていたとき（返事だけ失われた）、確定するのは作成だけ。
   * あとから畳んだ書き換えを別に覚えていないと、送り直す手がかりが無くなる。
   */
  it('create のあとの update は、作成のあとの書き換えを別に覚える', () => {
    const created = collapse(undefined, makeOp({ row: { id: 'note-1', text: '', x: 0 } }))!
    const first = collapse(created, makeOp({ kind: 'update', patch: { text: 'あ' } }))!
    const second = collapse(first, makeOp({ kind: 'update', patch: { x: 40 } }))!
    expect(second.patch).toEqual({ text: 'あ', x: 40 })
    expect(second.row).toEqual({ id: 'note-1', text: 'あ', x: 40 })
  })

  /*
   * 送信箱の作成は、どれも一度送ろうとして返事を受け取れなかったもの。
   * 実は届いていることがあるので、捨てると消したはずの行がサーバーに残る。
   */
  it('create のあとの delete は、中身を捨てて「消す」の 1 件だけ残す', () => {
    const created = collapse(undefined, makeOp({ row: { id: 'note-1', text: 'すぐ消す' } }))!
    const edited = collapse(created, makeOp({ kind: 'update', patch: { text: 'すぐ消す!' } }))!
    const entry = collapse(edited, makeOp({ kind: 'delete' }))
    expect(entry.kind).toBe('delete')
    expect(entry.row).toBeUndefined()
    expect(entry.patch).toBeUndefined()
    // 送る中身に本文が残らない
    expect(JSON.stringify(entry)).not.toContain('"text"')
  })

  it('消したあとに作り直したら、作り直した行で作成になる', () => {
    const deleted = collapse(undefined, makeOp({ kind: 'delete' }))
    const entry = collapse(deleted, makeOp({ kind: 'create', row: { id: 'note-1', text: '戻した' } }))
    expect(entry).toMatchObject({ kind: 'create', row: { text: '戻した' } })
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

  it('ロックはいちばん最初のものを保つ', () => {
    const first = collapse(
      undefined,
      makeOp({ kind: 'update', patch: { text: 'あ' }, expectUpdatedAt: 'U0' }),
    )!
    const entry = collapse(
      first,
      makeOp({ kind: 'update', patch: { text: 'いろは' }, expectUpdatedAt: 'U1' }),
    )!
    expect(entry.expectUpdatedAt).toBe('U0')
  })

  /*
   * 先にためたのが位置だけ（ロック無し）だと、以前はあとの本文の書き換えの
   * ロックまで捨てていた。本文が他の人の書き換えを黙って上書きしていた。
   */
  it('位置だけの更新に本文の書き換えを畳んでも、ロックは外れない', () => {
    const moved = collapse(undefined, makeOp({ kind: 'update', patch: { x: 10, y: 20 } }))!
    expect(moved.expectUpdatedAt).toBeUndefined()

    const entry = collapse(
      moved,
      makeOp({ kind: 'update', patch: { text: '書いた' }, expectUpdatedAt: 'U0' }),
    )!
    expect(entry.patch).toEqual({ x: 10, y: 20, text: '書いた' })
    expect(entry.expectUpdatedAt).toBe('U0')
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

  /*
   * 送っているあいだに書き足されたかどうかは、これでしか見分けられない
   * （送るのは flush が始めた時点の写しなので、往復中の書き足しは入っていない）。
   */
  it('ためるたびに rev が増える', () => {
    const first = collapse(undefined, makeOp({ row: { id: 'note-1', text: 'あ' } }))!
    expect(first.rev).toBe(1)
    const second = collapse(first, makeOp({ kind: 'update', patch: { text: 'あい' } }))!
    expect(second.rev).toBe(2)
    const third = collapse(second, makeOp({ kind: 'update', patch: { text: 'あいう' } }))!
    expect(third.rev).toBe(3)
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
  it('主キーの重複は成功として扱い、作成が前に届いていたことを印にする', () => {
    expect(
      classifyError({
        code: '23505',
        message: 'duplicate key value violates unique constraint "notes_pkey"',
        details: 'Key (id)=(note-1) already exists.',
      }),
    ).toEqual({ outcome: 'success', alreadyExisted: true })
  })

  it('details が返らない版でも、制約名が主キーなら同じく扱う', () => {
    // ローカルの Supabase（PostgREST）はこの形で返す。details だけを見ていると取りこぼす
    expect(
      classifyError({
        code: '23505',
        message: 'duplicate key value violates unique constraint "notes_pkey"',
        details: null as unknown as string,
      }),
    ).toEqual({ outcome: 'success', alreadyExisted: true })
  })

  it('主キー以外の重複は、details が返らなくても送れなかったものとして残す', () => {
    const result = classifyError({
      code: '23505',
      message: 'duplicate key value violates unique constraint "todos_next_occurrence_uidx"',
      details: null as unknown as string,
    })
    expect(result).toMatchObject({ outcome: 'dead', reason: 'duplicate' })
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
    expect(classifyError({ message: 'TypeError: Failed to fetch' })).toEqual({
      outcome: 'retry',
      transport: true,
    })
    expect(classifyError({ status: 503, message: 'unavailable' })).toEqual({ outcome: 'retry' })
    expect(classifyError({ status: 429, message: 'too many' })).toEqual({ outcome: 'retry' })
  })

  /*
   * 「届かなかった」と「届いたうえで断られた」は数え方が変わるので、印で分ける。
   * ここが同じ扱いに戻ると、圏外にいるだけで送信箱が打ち切られる。
   */
  it('届かなかったものには印を付ける（5xx とは分ける）', () => {
    expect(classifyError({ message: 'NetworkError' })).toMatchObject({ transport: true })
    expect(classifyError({ status: 503, message: 'unavailable' })).not.toMatchObject({
      transport: true,
    })
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

  it('混んでいて断られた（429）ときも、ためる', () => {
    expect(decideOnFailure(withStatus({ message: 'rate limited' }, 429))).toBe('queue')
  })

  /*
   * postgrest-js の error には status が無い（結果の側にある）。
   * 呼ぶ側が withStatus で添えないと、5xx も 429 も見分けられない。
   */
  it('status を添えた error なら、送信箱でも送り直しに回す', () => {
    expect(classifyError(withStatus({ message: 'upstream unavailable' }, 503))).toMatchObject({
      outcome: 'retry',
    })
    expect(classifyError(withStatus({ message: 'rate limited' }, 429))).toMatchObject({
      outcome: 'retry',
    })
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

describe('alreadyApplied', () => {
  /*
   * 更新は届いたのに返事だけが失われると、ためたときのロックで送り直して 0 行になる。
   * サーバーがもう送ろうとした中身なら、競合ではなく「送れていた」。
   */
  it('送ろうとした列がどれもサーバーと同じなら、送れていた', () => {
    const server = { id: 'note-1', text: '書いた', tags: ['大事'], x: 10, updated_at: 'U1' }
    expect(alreadyApplied({ text: '書いた', tags: ['大事'] }, server)).toBe(true)
  })

  it('1 つでも違えば、送れていない（競合として見せる）', () => {
    const server = { id: 'note-1', text: 'けいこが書いた', tags: ['大事'] }
    expect(alreadyApplied({ text: '書いた', tags: ['大事'] }, server)).toBe(false)
    expect(alreadyApplied({ tags: ['大事', '急ぎ'] }, server)).toBe(false)
  })

  it('行が無い・変更が空なら、送れていたことにしない', () => {
    expect(alreadyApplied({ text: '書いた' }, null)).toBe(false)
    expect(alreadyApplied({}, { text: '書いた' })).toBe(false)
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

describe('afterSend', () => {
  /*
   * ここが緩むと、送っているあいだに書き足した文字が黙って消える。
   * 「書いたのに消えた」がいちばん困る形で起きるところ。
   */
  it('ためた回数が動いていなければ、そのまま捨てる', () => {
    expect(afterSend(makeEntry({ rev: 3 }), 3)).toBe('drop')
  })

  it('送っているあいだに書き足されていたら、捨てずに送り直す', () => {
    const next = afterSend(makeEntry({ kind: 'update', rev: 4 }), 3)
    expect(next).not.toBe('drop')
    expect(next).toMatchObject({ state: 'pending' })
  })

  /*
   * いま送った更新で、サーバーの updated_at はもう進んでいる。古いロックのまま
   * 送り直すと 0 行になり、自分の書き込みが「他の人が先に書き換えました」で止まっていた。
   */
  it('更新を送り直すときは、送れた行の updated_at にロックを掛け直す', () => {
    const next = afterSend(
      makeEntry({ kind: 'update', rev: 4, patch: { text: 'つづき' }, expectUpdatedAt: 'U0' }),
      3,
      false,
      'U1',
    )
    expect(next).toMatchObject({ expectUpdatedAt: 'U1' })
  })

  it('ロックを掛けていなかった更新には、送り直しでも掛けない', () => {
    const next = afterSend(makeEntry({ kind: 'update', rev: 4, patch: { x: 5 } }), 3, false, 'U1')
    expect(next).not.toBe('drop')
    expect((next as Partial<QueueEntry>).expectUpdatedAt).toBeUndefined()
  })

  /*
   * 作成のまま送り直すと主キーの重複になり、「前回が実は通っていた」として
   * 捨てられて、やはり書き足しが消える。行はもうあるので更新に変える。
   */
  it('作成は更新に変える。id と updated_at は落とす', () => {
    const next = afterSend(
      makeEntry({
        kind: 'create',
        rev: 2,
        row: { id: 'note-1', room_id: 'room-1', text: 'あとで足した', updated_at: 'x' },
      }),
      1,
    )

    expect(next).toMatchObject({
      kind: 'update',
      row: undefined,
      expectUpdatedAt: undefined,
      patch: { room_id: 'room-1', text: 'あとで足した' },
    })
    const patch = (next as Partial<QueueEntry>).patch ?? {}
    expect(Object.keys(patch).sort()).toEqual(['room_id', 'text'])
  })

  it('送り直すときは、待ち時間と試した回数を仕切り直す', () => {
    const next = afterSend(
      makeEntry({ kind: 'update', rev: 9, attempts: 5, transportAttempts: 4, nextAttemptAt: 999 }),
      8,
    )
    expect(next).toMatchObject({ attempts: 0, transportAttempts: 0, nextAttemptAt: undefined })
  })

  /*
   * 作成が主キーの重複で返ってきた = 前の INSERT が届いていた。確定したのは作成だけで、
   * そのあとに畳んだ書き換えは、重複で断られた INSERT に入っていただけで届いていない。
   * ここを「全部送れた」と数えると、付箋を貼ったあとに書いた文字が黙って消える。
   */
  it('作成が前に届いていたら、あとから畳んだ書き換えだけを更新として送り直す', () => {
    const next = afterSend(
      makeEntry({
        kind: 'create',
        rev: 2,
        row: { id: 'note-1', room_id: 'room-1', text: 'あとで書いた', x: 0 },
        patch: { text: 'あとで書いた' },
      }),
      2,
      true,
    )
    expect(next).toEqual({
      state: 'pending',
      attempts: 0,
      transportAttempts: 0,
      nextAttemptAt: undefined,
      kind: 'update',
      row: undefined,
      patch: { text: 'あとで書いた' },
      expectUpdatedAt: undefined,
    })
  })

  it('作成が前に届いていて、あとの書き換えが無ければ片付ける', () => {
    expect(afterSend(makeEntry({ kind: 'create', rev: 1, row: { id: 'note-1' } }), 1, true)).toBe(
      'drop',
    )
  })

  it('送っているあいだに「消す」へ変わっていたら、重複で返っても消しに行く', () => {
    const next = afterSend(makeEntry({ kind: 'delete', rev: 3 }), 2, true)
    expect(next).toMatchObject({ state: 'pending' })
    expect(next).not.toMatchObject({ kind: 'update' })
  })
})

describe('nextRetryState', () => {
  /*
   * ここが壊れると、オフラインで書いたものが「つながったら送られる」のではなく
   * 11 分ほど（1+2+5+15+60+300+300 秒）で全件「送れませんでした」に落ちる。
   * 目で見て気づける類の壊れ方ではないので、厚めに見る。
   */
  it('届かなかったぶんは、試した回数に数えない', () => {
    let transportAttempts = 0
    for (let i = 0; i < 50; i += 1) {
      const next = nextRetryState({ attempts: 0, transportAttempts }, true, 0)
      expect(next.state).toBe('pending')
      expect(next.attempts).toBeUndefined()
      transportAttempts = next.transportAttempts ?? 0
    }
    expect(transportAttempts).toBe(50)
  })

  it('届かないあいだも、様子見の間隔は伸びて 5 分で頭打ちになる', () => {
    const at = (transportAttempts: number) =>
      nextRetryState({ attempts: 0, transportAttempts }, true, 1_000).nextAttemptAt
    expect(at(0)).toBe(1_000 + 1_000)
    expect(at(1)).toBe(1_000 + 2_000)
    expect(at(5)).toBe(1_000 + 300_000)
    expect(at(99)).toBe(1_000 + 300_000)
  })

  it('サーバーに断られたぶんは数え、上限で打ち切る', () => {
    expect(nextRetryState({ attempts: 0 }, false, 0)).toMatchObject({
      state: 'pending',
      attempts: 1,
    })
    expect(nextRetryState({ attempts: MAX_ATTEMPTS - 1 }, false, 0)).toMatchObject({
      state: 'failed',
      attempts: MAX_ATTEMPTS,
      reason: 'unknown',
    })
  })

  it('圏外を挟んでも、サーバーに断られた回数はそのまま', () => {
    // attempts を返さない = updateEntry がその列に触らない = 3 のまま残る
    expect(nextRetryState({ attempts: 3 }, true, 0).attempts).toBeUndefined()
    expect(nextRetryState({ attempts: 3 }, false, 0)).toMatchObject({ attempts: 4 })
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

describe('retryPatch', () => {
  const failedUpdate = (over: Partial<QueueEntry>) =>
    makeEntry({
      kind: 'update',
      state: 'failed',
      attempts: 7,
      errorText: '何度か試しましたが送れませんでした。',
      expectUpdatedAt: '2026-09-08T00:00:00.000Z',
      ...over,
    })

  /*
   * 「もう一度送る」は、ロックを保ったまま送り直す。以前は理由を問わずロックを外して
   * いたので、そのあいだに他の人が本文を書き換えていても、黙って上書きしていた。
   * 外してよいのは、両方の文面を見たうえで「自分の内容にする」を選んだとき（競合）だけ。
   */
  it('競合でなければ、ロックを保ったまま送り直す', () => {
    const patch = retryPatch(failedUpdate({ reason: 'unknown' }))
    expect(patch).toMatchObject({ state: 'pending', attempts: 0, reason: undefined })
    expect(patch).not.toHaveProperty('expectUpdatedAt')
  })

  it('競合で「自分の内容にする」を選んだときだけ、ロックを外す', () => {
    const patch = retryPatch(failedUpdate({ reason: 'conflict', serverText: '相手の本文' }))
    expect(patch).toHaveProperty('expectUpdatedAt', undefined)
    expect(patch).toMatchObject({ state: 'pending', serverText: undefined })
  })
})
