import { describe, expect, it } from 'vitest'
import { buildPastedNotes, notesToText } from '../boardClipboard'
import type { Note } from '../types'

const CTX = {
  roomId: 'room-1',
  userId: 'me',
  displayName: 'わたし',
  x: 100,
  y: 200,
  baseZ: 5,
  boardW: 2000,
  boardH: 1200,
}

function note(over: Partial<Note> = {}): Note {
  return {
    id: 'original',
    room_id: 'other-room',
    kind: 'sticky',
    x: 10,
    y: 20,
    w: 220,
    h: 170,
    color: 'yellow',
    text: 'メモ',
    tags: ['タグ'],
    z: 99,
    font_size: 0,
    deleted_at: null,
    author_id: 'someone-else',
    author_name: 'だれか',
    created_at: '2020-01-01T00:00:00.000Z',
    updated_at: '2020-01-01T00:00:00.000Z',
    ...over,
  }
}

describe('buildPastedNotes（貼り付ける付箋を組み立てる）', () => {
  it('id・部屋・作者を必ず自分のものに差し替える', () => {
    const [pasted] = buildPastedNotes([note()], CTX)

    expect(pasted.id).not.toBe('original')
    expect(pasted.room_id).toBe('room-1')
    // RLS の INSERT 条件が author_id = auth.uid() なので、ここを引き継ぐと 1 件も入らない
    expect(pasted.author_id).toBe('me')
    expect(pasted.author_name).toBe('わたし')
    expect(pasted.deleted_at).toBeNull()
  })

  it('まとまりの左上を貼り付け先に合わせ、相互の位置関係は保つ', () => {
    const rows = [note({ x: 10, y: 20 }), note({ x: 60, y: 120 })]
    const pasted = buildPastedNotes(rows, CTX)

    expect([pasted[0].x, pasted[0].y]).toEqual([100, 200])
    expect([pasted[1].x, pasted[1].y]).toEqual([150, 300])
  })

  it('重なり順は baseZ の上に順番に積む', () => {
    const pasted = buildPastedNotes([note(), note(), note()], CTX)
    expect(pasted.map((n) => n.z)).toEqual([6, 7, 8])
  })

  it('ボードからはみ出す位置は中に収める', () => {
    const pasted = buildPastedNotes([note()], { ...CTX, x: 9999, y: 9999 })
    expect(pasted[0].x).toBe(2000 - 220)
    expect(pasted[0].y).toBe(1200 - 170)
  })

  it('知らない色は既定の黄色にする', () => {
    expect(buildPastedNotes([note({ color: 'rainbow' })], CTX)[0].color).toBe('yellow')
    expect(buildPastedNotes([note({ color: 'blue' })], CTX)[0].color).toBe('blue')
  })

  it('知らない kind は付箋として扱う', () => {
    const odd = { ...note(), kind: 'hologram' } as unknown as Note
    expect(buildPastedNotes([odd], CTX)[0].kind).toBe('sticky')
    expect(buildPastedNotes([note({ kind: 'text' })], CTX)[0].kind).toBe('text')
  })

  it('本文は 1000 文字までにし、制御文字を落とす（改行とタブは残す）', () => {
    const long = buildPastedNotes([note({ text: 'あ'.repeat(2000) })], CTX)[0]
    expect(long.text).toHaveLength(1000)

    const dirty = buildPastedNotes([note({ text: 'a\u0000b\u001Fc\td\r\ne' })], CTX)[0]
    expect(dirty.text).toBe('abc\td\ne')
  })

  it('タグが配列でなくても壊れない', () => {
    const broken = { ...note(), tags: 'タグ' } as unknown as Note
    expect(buildPastedNotes([broken], CTX)[0].tags).toEqual([])
  })

  it('数値が壊れていても NaN を書き込まない', () => {
    const broken = { ...note(), w: NaN, x: Infinity } as unknown as Note
    const pasted = buildPastedNotes([broken], CTX)[0]
    expect(Number.isFinite(pasted.w)).toBe(true)
    expect(Number.isFinite(pasted.x)).toBe(true)
  })

  it('60 件を超えるぶんは捨てる', () => {
    const many = Array.from({ length: 100 }, () => note())
    expect(buildPastedNotes(many, CTX)).toHaveLength(60)
  })

  it('空なら空を返す', () => {
    expect(buildPastedNotes([], CTX)).toEqual([])
  })
})

describe('notesToText', () => {
  it('本文を改行でつなぐ', () => {
    expect(notesToText([note({ text: '一' }), note({ text: '二' })])).toBe('一\n二')
  })
})
