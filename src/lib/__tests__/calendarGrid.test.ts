import { describe, expect, it } from 'vitest'
import { HOUR_HEIGHT, SNAP_MINUTES, dragDeltaMs } from '../calendarGrid'

/*
 * 週・日表示で掴んで動かしたときの「どれだけ動かすか」。
 *
 * 丸めを 1 つ間違えても、画面上は近いところに落ちるので目では気づけない。
 * 予定が 15 分ずれたまま保存されるのが、一番ありそうな壊れ方。
 */

const COLUMN = 100
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

describe('dragDeltaMs', () => {
  it('動かしていなければ 0', () => {
    expect(dragDeltaMs(0, 0, COLUMN)).toBe(0)
  })

  it('列 1 つぶん右へ動かすと 1 日ぶん', () => {
    expect(dragDeltaMs(COLUMN, 0, COLUMN)).toBe(DAY)
    expect(dragDeltaMs(-COLUMN * 2, 0, COLUMN)).toBe(-2 * DAY)
  })

  it('列の半分を超えたところで次の日に移る', () => {
    expect(dragDeltaMs(COLUMN * 0.49, 0, COLUMN)).toBe(0)
    expect(dragDeltaMs(COLUMN * 0.51, 0, COLUMN)).toBe(DAY)
  })

  it('1 時間ぶんの高さで 60 分', () => {
    expect(dragDeltaMs(0, HOUR_HEIGHT, COLUMN)).toBe(60 * MINUTE)
    expect(dragDeltaMs(0, -HOUR_HEIGHT, COLUMN)).toBe(-60 * MINUTE)
  })

  it('時刻は 15 分の単位に丸める', () => {
    // 1 時間の高さが 48px なので、15 分は 12px
    expect(dragDeltaMs(0, 12, COLUMN)).toBe(SNAP_MINUTES * MINUTE)
    expect(dragDeltaMs(0, 17, COLUMN)).toBe(SNAP_MINUTES * MINUTE)
    expect(dragDeltaMs(0, 19, COLUMN)).toBe(2 * SNAP_MINUTES * MINUTE)
  })

  it('刻みの半分に満たなければ動かさない', () => {
    expect(dragDeltaMs(0, 5, COLUMN)).toBe(0)
  })

  it('日と時刻の両方を足して返す', () => {
    expect(dragDeltaMs(COLUMN, HOUR_HEIGHT, COLUMN)).toBe(DAY + 60 * MINUTE)
  })

  it('幅を測る前に掴まれても、日はまたがない（0 で割らない）', () => {
    expect(dragDeltaMs(500, HOUR_HEIGHT, 0)).toBe(60 * MINUTE)
  })
})
