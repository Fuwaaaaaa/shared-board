import { describe, expect, it } from 'vitest'
import { planUndoCreate, type NoteDependents } from '../undoCreate'
import type { Note } from '../types'

function note(patch: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    room_id: 'r1',
    kind: 'sticky',
    x: 0,
    y: 0,
    w: 220,
    h: 170,
    color: 'yellow',
    text: '',
    tags: [],
    z: 1,
    font_size: 0,
    deleted_at: null,
    author_id: 'me',
    author_name: 'ゆうき',
    created_at: '2026-09-28T00:00:00Z',
    updated_at: '2026-09-28T00:00:00Z',
    ...patch,
  }
}

const NONE: NoteDependents = {
  connectors: [],
  trashedConnectors: [],
  votes: [],
  reactions: [],
  comments: [],
  derived: [],
}

function plan(current: Note | undefined, deps: Partial<NoteDependents> = {}, created = note()) {
  return planUndoCreate([created], () => current, { ...NONE, ...deps }, 'me')
}

describe('planUndoCreate', () => {
  it('作ったときのまま何もぶら下がっていなければ、本当に消す', () => {
    const created = note()
    expect(plan(note(), {}, created)).toEqual({ drop: [created], trash: [] })
  })

  it('他の人が書き換えていたら、ゴミ箱へ入れる（いまの行で）', () => {
    const current = note({ text: 'けいこが書いた' })
    expect(plan(current)).toEqual({ drop: [], trash: [current] })
  })

  it('色やタグが変わっていても、ゴミ箱へ入れる', () => {
    expect(plan(note({ color: 'pink' })).trash).toHaveLength(1)
    expect(plan(note({ tags: ['大事'] })).trash).toHaveLength(1)
  })

  it('動かされただけなら、本当に消す（位置は中身ではない）', () => {
    expect(plan(note({ x: 400, y: 300 })).drop).toHaveLength(1)
  })

  /*
   * ここが直したかったところ。線・👍・絵文字は on delete cascade なので、
   * 本当に消すと他の人のぶんまで巻き添えで消え、ゴミ箱にも残らない。
   */
  it('線・👍・絵文字・コメント・やることが付いていたら、ゴミ箱へ入れる', () => {
    const cases: Partial<NoteDependents>[] = [
      { connectors: [{ from_note_id: 'n2', to_note_id: 'n1' }] },
      { votes: [{ note_id: 'n1' }] },
      { reactions: [{ note_id: 'n1' }] },
      { comments: [{ target_type: 'note', target_id: 'n1' }] },
      { derived: [{ source_note_id: 'n1' }] },
    ]
    for (const deps of cases) {
      expect(plan(note(), deps).trash, JSON.stringify(deps)).toHaveLength(1)
    }
  })

  it('他の付箋に付いたものは関係ない', () => {
    const deps: Partial<NoteDependents> = {
      connectors: [{ from_note_id: 'n2', to_note_id: 'n3' }],
      votes: [{ note_id: 'n2' }],
      comments: [{ target_type: 'event', target_id: 'n1' }],
    }
    expect(plan(note(), deps).drop).toHaveLength(1)
  })

  it('ゴミ箱にある線は、他の人のものだけ数える', () => {
    const mine = { from_note_id: 'n1', to_note_id: 'n2', author_id: 'me' }
    const theirs = { from_note_id: 'n1', to_note_id: 'n2', author_id: 'keiko' }
    // 自分でつないで取り消しただけなら、作ってすぐの取り消しと同じ
    expect(plan(note(), { trashedConnectors: [mine] }).drop).toHaveLength(1)
    // 他の人が消した線は、本当に消すとその人が戻せなくなる
    expect(plan(note(), { trashedConnectors: [theirs] }).trash).toHaveLength(1)
  })

  it('もう無い・誰かがゴミ箱へ入れた付箋には触らない', () => {
    expect(plan(undefined)).toEqual({ drop: [], trash: [] })
    expect(plan(note({ deleted_at: '2026-09-28T01:00:00Z' }))).toEqual({ drop: [], trash: [] })
  })

  it('まとめて作った付箋は、1 枚ずつ振り分ける', () => {
    const a = note({ id: 'a' })
    const b = note({ id: 'b' })
    const current = new Map([
      ['a', a],
      ['b', note({ id: 'b', text: '書き足した' })],
    ])
    const result = planUndoCreate([a, b], (id) => current.get(id), NONE, 'me')
    expect(result.drop.map((n) => n.id)).toEqual(['a'])
    expect(result.trash.map((n) => n.id)).toEqual(['b'])
  })
})
