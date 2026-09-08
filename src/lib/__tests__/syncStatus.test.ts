import { beforeEach, describe, expect, it } from 'vitest'
import { SYNC_LABELS, beginWrite, clearSyncError, endWrite, syncSnapshot } from '../syncStatus'

/*
 * ヘッダーの「保存済み / 同期中 / 保存できません」。
 *
 * 共同編集でいちばん不安になるのは「自分の書いたものが届いたか」なので、
 * ここが嘘をつくと信用そのものが落ちる。数え間違いは画面を見ても分からない。
 *
 * モジュールに 1 つだけ持つ状態なので、テストごとに数え戻してから始める。
 */

/** 送信中を 0 に戻し、エラーも消す */
function reset() {
  // 余分に終わらせても 0 より下がらない作りになっている
  for (let i = 0; i < 5; i += 1) endWrite(true)
  clearSyncError()
}

describe('syncStatus', () => {
  beforeEach(reset)

  it('何も送っていなければ「保存済み」', () => {
    expect(syncSnapshot()).toBe('saved')
  })

  it('送っている間は「同期中」', () => {
    beginWrite()
    expect(syncSnapshot()).toBe('saving')
  })

  it('重なって送っていると、最後の 1 つが返るまで「同期中」', () => {
    beginWrite()
    beginWrite()
    endWrite(true)
    expect(syncSnapshot()).toBe('saving')
    endWrite(true)
    expect(syncSnapshot()).toBe('saved')
  })

  it('断られたら「保存できません」', () => {
    beginWrite()
    endWrite(false)
    expect(syncSnapshot()).toBe('error')
  })

  it('次の書き込みが通れば、自然に戻る', () => {
    beginWrite()
    endWrite(false)
    beginWrite()
    endWrite(true)
    expect(syncSnapshot()).toBe('saved')
  })

  it('まだ送っているものがあるうちは、エラーより「同期中」を出す', () => {
    // 1 件失敗しても、続けて送っているものがあるなら、まだ確定していない
    beginWrite()
    beginWrite()
    endWrite(false)
    expect(syncSnapshot()).toBe('saving')
  })

  it('終わらせすぎても、数が負にならない', () => {
    endWrite(true)
    endWrite(true)
    beginWrite()
    expect(syncSnapshot()).toBe('saving')
    endWrite(true)
    expect(syncSnapshot()).toBe('saved')
  })

  it('4 つの状態に、それぞれ画面に出す文言がある', () => {
    for (const state of ['saved', 'saving', 'offline', 'error'] as const) {
      expect(SYNC_LABELS[state].label).not.toBe('')
      expect(SYNC_LABELS[state].title).not.toBe('')
    }
  })
})
