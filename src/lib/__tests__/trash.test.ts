import { describe, expect, it } from 'vitest'
import { connectorRestoreBlock, daysLeftInTrash, sortTrashed, TRASH_DAYS } from '../trash'

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
