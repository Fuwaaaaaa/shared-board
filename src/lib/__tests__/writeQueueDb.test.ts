import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueueEntry } from '../writeQueue'

/*
 * 送信箱の置き場（IndexedDB）。
 *
 * 2 つの形で、ためた分が黙って消えていた。
 *   1. 書けたかどうかを要求の onsuccess で決めていた。容量不足（QuotaExceededError）は
 *      コミットのときにトランザクションごと取り消す形で出るので、書けたことになっていた。
 *   2. 1 回書けないとメモリの置き場を作り、そのあとは IndexedDB にある分を読まなくなった。
 *      新しく入れた分もメモリにしか置かず、それでも「端末に残っている」と出していた。
 *
 * ブラウザの IndexedDB の代わりに、要求とトランザクションの流れだけをまねた偽物を置く。
 */

type PutMode = 'ok' | 'request-error' | 'abort'

function fakeIndexedDB() {
  const data = new Map<string, QueueEntry>()
  const state = { put: 'ok' as PutMode }
  const later = (fn: () => void) => setTimeout(fn, 0)

  interface FakeRequest {
    result?: unknown
    error?: unknown
    onsuccess?: () => void
    onerror?: () => void
  }
  interface FakeTransaction {
    error: unknown
    oncomplete?: () => void
    onabort?: () => void
    onerror?: () => void
    objectStore: () => unknown
  }

  const db = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const tx: FakeTransaction = { error: null, objectStore: () => store }
      const complete = () => later(() => tx.oncomplete?.())
      const abort = (error: unknown) => {
        tx.error = error
        later(() => tx.onabort?.())
      }
      const store = {
        getAll() {
          const req: FakeRequest = {}
          later(() => {
            req.result = [...data.values()]
            req.onsuccess?.()
            complete()
          })
          return req
        },
        put(entry: QueueEntry) {
          const req: FakeRequest = {}
          later(() => {
            if (state.put === 'request-error') {
              req.error = new Error('put failed')
              req.onerror?.()
              abort(req.error)
              return
            }
            req.result = entry.key
            req.onsuccess?.()
            // 容量不足は、要求が通ったあと、コミットのときに取り消しとして出る
            if (state.put === 'abort') return abort(new Error('QuotaExceededError'))
            data.set(entry.key, entry)
            complete()
          })
          return req
        },
        delete(key: string) {
          const req: FakeRequest = {}
          later(() => {
            data.delete(key)
            req.onsuccess?.()
            complete()
          })
          return req
        },
      }
      return tx
    },
  }

  const indexedDB = {
    open() {
      const req: FakeRequest & { onupgradeneeded?: () => void } = {}
      later(() => {
        req.result = db
        req.onsuccess?.()
      })
      return req
    },
  }
  return { indexedDB, data, state }
}

class SilentChannel {
  postMessage() {}
  addEventListener() {}
  removeEventListener() {}
}

const entry = (key: string): QueueEntry => ({ key }) as QueueEntry

let fake: ReturnType<typeof fakeIndexedDB>
let store: typeof import('../writeQueueDb')

beforeEach(async () => {
  fake = fakeIndexedDB()
  vi.stubGlobal('indexedDB', fake.indexedDB)
  vi.stubGlobal('BroadcastChannel', SilentChannel)
  vi.resetModules()
  store = await import('../writeQueueDb')
  await store.openQueue()
})

describe('writeQueueDb', () => {
  it('ふだんは IndexedDB に置き、端末に残っていると言う', async () => {
    await store.put(entry('a'))
    expect([...fake.data.keys()]).toEqual(['a'])
    expect((await store.readAll()).map((e) => e.key)).toEqual(['a'])
    expect(store.isPersistent()).toBe(true)
  })

  it('要求が通ってもトランザクションが取り消されたら、書けたことにしない', async () => {
    fake.state.put = 'abort'
    await store.put(entry('a'))

    expect(fake.data.size).toBe(0)
    // このタブが開いているあいだは拾え、閉じると消えることを画面に出せる
    expect((await store.readAll()).map((e) => e.key)).toEqual(['a'])
    expect(store.isPersistent()).toBe(false)
  })

  it('1 回書けなくても、IndexedDB にある分はそのまま読む', async () => {
    await store.put(entry('a'))
    fake.state.put = 'request-error'
    await store.put(entry('b'))

    expect((await store.readAll()).map((e) => e.key).sort()).toEqual(['a', 'b'])
    expect(store.isPersistent()).toBe(false)
  })

  it('あとで書けたら、IndexedDB に置き直し、端末に残っていると言い直す', async () => {
    fake.state.put = 'request-error'
    await store.put(entry('b'))
    fake.state.put = 'ok'
    await store.put(entry('c'))
    await store.put(entry('b'))

    expect([...fake.data.keys()].sort()).toEqual(['b', 'c'])
    expect((await store.readAll()).map((e) => e.key).sort()).toEqual(['b', 'c'])
    expect(store.isPersistent()).toBe(true)
  })

  it('消すときは、書けなかった分からも消す', async () => {
    fake.state.put = 'request-error'
    await store.put(entry('b'))
    await store.remove('b')

    expect(await store.readAll()).toEqual([])
    expect(store.isPersistent()).toBe(true)
  })
})
