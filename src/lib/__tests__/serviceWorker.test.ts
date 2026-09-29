import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

/*
 * public/sw.js のキャッシュ。
 *
 * Service Worker はブラウザでしか動かないので、self・caches・fetch を差し替えた
 * 箱の中で読み込み、fetch イベントを直接送る。
 */

const ORIGIN = 'https://board.example.test'
const source = readFileSync(new URL('../../../public/sw.js', import.meta.url), 'utf8')

type Listener = (event: unknown) => void

function loadServiceWorker(upstream: (url: string) => Response) {
  const listeners: Record<string, Listener> = {}
  const stored = new Map<string, Response>()
  const cache = {
    put: vi.fn((request: Request | string, response: Response) => {
      stored.set(typeof request === 'string' ? request : request.url, response)
      return Promise.resolve()
    }),
    addAll: vi.fn(() => Promise.resolve()),
  }
  const caches = {
    open: () => Promise.resolve(cache),
    match: (request: Request | string) =>
      Promise.resolve(stored.get(typeof request === 'string' ? request : request.url)),
    keys: () => Promise.resolve([]),
    delete: () => Promise.resolve(true),
  }
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: Listener) => {
      listeners[type] = listener
    },
  }
  const fetch = (request: Request) => Promise.resolve(upstream(request.url))

  new Function('self', 'caches', 'fetch', source)(self, caches, fetch)

  async function get(path: string): Promise<Response> {
    let responded: Promise<Response> | undefined
    listeners.fetch({
      request: new Request(ORIGIN + path),
      respondWith: (response: Promise<Response>) => {
        responded = response
      },
    })
    const response = await responded!
    // 控えるのは応答を返したあと（caches.open().then(...)）なので、ひと回り待つ
    await new Promise((resolve) => setTimeout(resolve, 0))
    return response
  }

  return { get, cache }
}

describe('sw.js — ビルド成果物のキャッシュ', () => {
  it('JS はキャッシュする', async () => {
    const sw = loadServiceWorker(
      () => new Response('export {}', { headers: { 'Content-Type': 'text/javascript' } }),
    )
    await sw.get('/assets/RoomPage-abc123.js')
    expect(sw.cache.put).toHaveBeenCalledTimes(1)
  })

  /*
   * デプロイをまたいで開いていたタブは、もう無い古いチャンクを取りに行く。
   * Vercel は無いパスにも index.html を 200 で返す（vercel.json の rewrites）ので、
   * それを JS の URL で控えると、キャッシュ優先のせいで読み込みが壊れたままになる
   * （古い版に戻したときにも、同じ URL が HTML のまま返り続ける）。
   */
  it('JS の URL に HTML が返ってきたら、キャッシュしない', async () => {
    const sw = loadServiceWorker(
      () => new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    )
    const response = await sw.get('/assets/RoomPage-old999.js')
    expect(sw.cache.put).not.toHaveBeenCalled()
    // 応答そのものは返す（読み込みの失敗は画面側が拾う）
    expect(response.status).toBe(200)
  })
})
