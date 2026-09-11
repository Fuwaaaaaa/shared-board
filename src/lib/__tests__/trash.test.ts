import { describe, expect, it } from 'vitest'
import {
  connectorRestoreBlock,
  daysLeftInTrash,
  ERASE_GAP_MS,
  groupErased,
  sortTrashed,
  TRASH_DAYS,
} from '../trash'

describe('connectorRestoreBlock', () => {
  /*
   * 線だけ戻しても、両端の付箋が見えていなければ画面には何も出ない
   * （ConnectorsLayer は両端を引けないと描かない）。
   * 「戻したのに出てこない」がいちばん困るので、押す前に断る。
   */
  const connector = { from_note_id: 'a', to_note_id: 'b' }

  it('両端が見えていれば戻せる', () => {
    expect(connectorRestoreBlock(connector, new Set(['a', 'b']), new Set())).toBeNull()
  })

  it('片方がゴミ箱にあるなら、そう言って止める', () => {
    expect(connectorRestoreBlock(connector, new Set(['a']), new Set(['b']))).toBe(
      'つなぐ先の付箋がゴミ箱にあります',
    )
  })

  it('両方ゴミ箱でも同じ', () => {
    expect(connectorRestoreBlock(connector, new Set(), new Set(['a', 'b']))).toBe(
      'つなぐ先の付箋がゴミ箱にあります',
    )
  })

  it('付箋がもう無いなら、別の理由を出す', () => {
    // 30 日を過ぎて本当に消えた付箋（線は複合 FK の cascade で一緒に消えるが、
    // 反映の途中でこの状態が見えることはある）
    expect(connectorRestoreBlock(connector, new Set(['a']), new Set())).toBe(
      'つなぐ先の付箋がもうありません',
    )
  })
})

describe('sortTrashed', () => {
  it('新しく捨てたものが上に来る', () => {
    const rows = [
      { id: 'old', deleted_at: '2026-09-01T00:00:00.000Z' },
      { id: 'new', deleted_at: '2026-09-08T00:00:00.000Z' },
      { id: 'mid', deleted_at: '2026-09-05T00:00:00.000Z' },
    ]
    expect(sortTrashed(rows).map((r) => r.id)).toEqual(['new', 'mid', 'old'])
  })

  it('元の配列は変えない', () => {
    const rows = [
      { id: 'a', deleted_at: '2026-09-01T00:00:00.000Z' },
      { id: 'b', deleted_at: '2026-09-08T00:00:00.000Z' },
    ]
    sortTrashed(rows)
    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('日付が無い行があっても落ちない', () => {
    const rows = [{ id: 'a', deleted_at: null }, { id: 'b', deleted_at: '2026-09-08T00:00:00.000Z' }]
    expect(sortTrashed(rows).map((r) => r.id)).toEqual(['b', 'a'])
  })
})

describe('daysLeftInTrash', () => {
  const deletedAt = '2026-09-01T00:00:00.000Z'

  it('捨てた直後は 30 日', () => {
    expect(daysLeftInTrash(deletedAt, new Date('2026-09-01T00:00:00.000Z'))).toBe(TRASH_DAYS)
  })

  it('日が進むと減る', () => {
    expect(daysLeftInTrash(deletedAt, new Date('2026-09-11T00:00:00.000Z'))).toBe(20)
    expect(daysLeftInTrash(deletedAt, new Date('2026-09-30T00:00:00.000Z'))).toBe(1)
  })

  it('端数は切り上げる（「あと 0 日」を早く出しすぎない）', () => {
    expect(daysLeftInTrash(deletedAt, new Date('2026-09-30T12:00:00.000Z'))).toBe(1)
  })

  it('期限を過ぎたら 0（負にはしない）', () => {
    expect(daysLeftInTrash(deletedAt, new Date('2026-10-01T00:00:00.000Z'))).toBe(0)
    expect(daysLeftInTrash(deletedAt, new Date('2026-12-01T00:00:00.000Z'))).toBe(0)
  })
})

describe('groupErased', () => {
  /*
   * 消しゴムは 1 本ずつ別の書き込みとして消すので、ゴミ箱に 1 行ずつ並ぶと
   * 一覧が埋まる。ひと撫でを 1 行に見せるためのまとめ方。
   */
  const at = (seconds: number) => new Date(Date.UTC(2026, 8, 1, 0, 0, seconds)).toISOString()
  const stroke = (id: string, author: string, seconds: number) => ({
    id,
    author_id: author,
    deleted_at: at(seconds),
  })

  it('続けて消した線は 1 つにまとまる', () => {
    const groups = groupErased([
      stroke('a', 'ゆうき', 0),
      stroke('b', 'ゆうき', 1),
      stroke('c', 'ゆうき', 2),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].rows.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('間が空いたら別のまとまりになる', () => {
    const groups = groupErased([
      stroke('a', 'ゆうき', 0),
      stroke('b', 'ゆうき', 1),
      stroke('c', 'ゆうき', 60),
    ])
    expect(groups.map((g) => g.rows.map((r) => r.id))).toEqual([['c'], ['a', 'b']])
  })

  it('間隔は前の行から数えるので、ゆっくり撫でても 1 つに収まる', () => {
    // 先頭からは 3 秒を超えるが、隣どうしは 2 秒ずつ
    const groups = groupErased([
      stroke('a', 'ゆうき', 0),
      stroke('b', 'ゆうき', 2),
      stroke('c', 'ゆうき', 4),
      stroke('d', 'ゆうき', 6),
    ])
    expect(groups).toHaveLength(1)
  })

  it('同時に 2 人が消しても、混ざらない', () => {
    const groups = groupErased([
      stroke('a', 'ゆうき', 0),
      stroke('b', 'けいこ', 0),
      stroke('c', 'ゆうき', 1),
    ])
    expect(groups).toHaveLength(3)
    expect(groups.every((g) => g.rows.length === 1)).toBe(true)
  })

  it('新しく消したまとまりが上に来る', () => {
    const groups = groupErased([stroke('old', 'ゆうき', 0), stroke('new', 'ゆうき', 60)])
    expect(groups.map((g) => g.key)).toEqual(['new', 'old'])
  })

  it('残り日数は、先に消えるほう（いちばん古い行）に合わせる', () => {
    const groups = groupErased([stroke('a', 'ゆうき', 0), stroke('b', 'ゆうき', 2)])
    expect(groups[0].deletedAt).toBe(at(0))
  })

  it('ゴミ箱に入っていない行は混ざらない', () => {
    const groups = groupErased([
      { id: 'live', author_id: 'ゆうき', deleted_at: null },
      stroke('a', 'ゆうき', 0),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].rows.map((r) => r.id)).toEqual(['a'])
  })

  it('境目ちょうどは同じまとまり', () => {
    const groups = groupErased([
      stroke('a', 'ゆうき', 0),
      { id: 'b', author_id: 'ゆうき', deleted_at: new Date(Date.UTC(2026, 8, 1) + ERASE_GAP_MS).toISOString() },
    ])
    expect(groups).toHaveLength(1)
  })

  it('空でも落ちない', () => {
    expect(groupErased([])).toEqual([])
  })
})
