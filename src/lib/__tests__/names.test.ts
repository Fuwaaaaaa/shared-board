import { describe, expect, it } from 'vitest'
import { buildNameLabels } from '../names'

/*
 * 同じ表示名の人を見分ける。
 *
 * ログインが無く、表示名は自己申告なので「ゆうき」が 2 人いることは普通に起きる。
 * 内部では参加者 ID で区別できているので、ぶつかったときだけ肩書きを足す。
 * ぶつかっていない人にまで括弧が付くと、ただ読みにくくなる。
 */

const ME = 'me'

function person(user_id: string, display_name: string) {
  return { user_id, display_name }
}

describe('buildNameLabels', () => {
  it('ぶつかっていない名前は、そのまま', () => {
    const labels = buildNameLabels([person(ME, 'ゆうき'), person('u2', 'けいこ')], ME)
    expect(labels.get(ME)).toBe('ゆうき')
    expect(labels.get('u2')).toBe('けいこ')
  })

  it('ぶつかったとき、自分には「この端末」が付く', () => {
    const labels = buildNameLabels([person(ME, 'ゆうき'), person('u2', 'ゆうき')], ME)
    expect(labels.get(ME)).toBe('ゆうき（この端末）')
    expect(labels.get('u2')).toBe('ゆうき（1）')
  })

  it('自分以外は、出てきた順に番号が付く', () => {
    const labels = buildNameLabels(
      [person('u1', 'ゆうき'), person('u2', 'ゆうき'), person('u3', 'ゆうき')],
      ME,
    )
    expect([labels.get('u1'), labels.get('u2'), labels.get('u3')]).toEqual([
      'ゆうき（1）',
      'ゆうき（2）',
      'ゆうき（3）',
    ])
  })

  it('名前ごとに数える。別の名前の番号は混ざらない', () => {
    const labels = buildNameLabels(
      [
        person('u1', 'ゆうき'),
        person('u2', 'けいこ'),
        person('u3', 'ゆうき'),
        person('u4', 'けいこ'),
      ],
      ME,
    )
    expect(labels.get('u1')).toBe('ゆうき（1）')
    expect(labels.get('u3')).toBe('ゆうき（2）')
    expect(labels.get('u2')).toBe('けいこ（1）')
    expect(labels.get('u4')).toBe('けいこ（2）')
  })

  it('前後の空白は同じ名前として扱う（見た目が同じなら見分けが要る）', () => {
    const labels = buildNameLabels([person(ME, 'ゆうき'), person('u2', '  ゆうき ')], ME)
    expect(labels.get(ME)).toBe('ゆうき（この端末）')
    expect(labels.get('u2')).toBe('ゆうき（1）')
  })

  it('名前を入れていない人は「名前なし」でまとめる', () => {
    const labels = buildNameLabels([person('u1', ''), person('u2', '   ')], ME)
    expect(labels.get('u1')).toBe('名前なし（1）')
    expect(labels.get('u2')).toBe('名前なし（2）')
  })

  it('1 人だけなら、名前なしでも括弧は付かない', () => {
    const labels = buildNameLabels([person('u1', '')], ME)
    expect(labels.get('u1')).toBe('名前なし')
  })
})
