/*
 * purge-storage（purge_queue に積まれた Storage の実体を消す）。
 *
 * service_role で本当にファイルを消しに行く場所なので、見るのは次の 3 つ。
 *   1. 合言葉なしでは何もしないこと
 *   2. まだ行から参照されている実体を消さないこと
 *      （ここが壊れると、ゴミ箱から戻したのに開けないファイルになる）
 *   3. 形のおかしい予約で詰まらないこと
 */

import { assertEquals } from 'jsr:@std/assert@1'
import { installFetchRouter, restJson, setFunctionEnv } from './helpers.ts'

setFunctionEnv()
Deno.env.set('CRON_SHARED_SECRET', 'purge-secret')
const net = installFetchRouter()
const { handler, isInRoomFolder, tableFor } = await import('../purge-storage/handler.ts')

// 大文字を弾けているか見たいので、英字の入った id にしておく
const ROOM = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

interface Routes {
  queue?: unknown[]
  /** images / attachments に残っている storage_path */
  referenced?: unknown[]
  /** list が返すファイル。呼ばれるたびに 1 つずつ取り出す */
  listPages?: unknown[][]
  /** remove を失敗させる */
  removeFails?: boolean
}

function routes(r: Routes = {}) {
  net.reset()
  const pages = [...(r.listPages ?? [[]])]
  net.use((url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()

    if (url.includes('/rest/v1/purge_queue')) return restJson(r.queue ?? [])
    if (url.includes('/rest/v1/images') || url.includes('/rest/v1/attachments')) {
      return restJson(r.referenced ?? [])
    }
    if (url.includes('/storage/v1/object/list/')) return restJson(pages.shift() ?? [])
    if (url.includes('/storage/v1/object/')) {
      if (method === 'DELETE' && r.removeFails) {
        return new Response(JSON.stringify({ message: 'storage が落ちています' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return restJson([])
    }
    return new Response('想定していない問い合わせ: ' + url, { status: 500 })
  })
}

function call(secret: string | null = 'purge-secret'): Request {
  const headers = new Headers()
  if (secret !== null) headers.set('x-cron-secret', secret)
  return new Request('https://fn.example.test/purge-storage', { method: 'POST', headers })
}

function objectRow(id: number, path: string, bucket = 'board-images') {
  return { id, bucket, kind: 'object', path, attempts: 0 }
}

// ---------------------------------------------------------------------------
//  パスの形
// ---------------------------------------------------------------------------

Deno.test('ボードのフォルダ配下だけを消す対象にする', () => {
  assertEquals(isInRoomFolder(ROOM + '/a.png'), true)
  assertEquals(isInRoomFolder(ROOM + '/sub/a.png'), true)

  assertEquals(isInRoomFolder('a.png'), false)
  assertEquals(isInRoomFolder('/a.png'), false)
  assertEquals(isInRoomFolder('not-a-uuid/a.png'), false)
  assertEquals(isInRoomFolder(ROOM.toUpperCase() + '/a.png'), false)
  // 上へ登ろうとするものは、形が合っていても通さない
  assertEquals(isInRoomFolder(ROOM + '/../other/a.png'), false)
})

Deno.test('バケットに対応するテーブル', () => {
  assertEquals(tableFor('board-images'), 'images')
  assertEquals(tableFor('board-files'), 'attachments')
  assertEquals(tableFor('avatars'), null)
})

// ---------------------------------------------------------------------------
//  認証
// ---------------------------------------------------------------------------

Deno.test('合言葉がなければ 401（DB にも触らない）', async () => {
  routes({ queue: [objectRow(1, ROOM + '/a.png')] })
  const res = await handler(call(null))
  assertEquals(res.status, 401)
  assertEquals(net.calls.length, 0)
  await res.text()
})

Deno.test('合言葉が違えば 401', async () => {
  routes()
  const res = await handler(call('wrong-secret'))
  assertEquals(res.status, 401)
  await res.text()
})

// ---------------------------------------------------------------------------
//  正常系
// ---------------------------------------------------------------------------

Deno.test('積まれた実体を消す', async () => {
  routes({ queue: [objectRow(1, ROOM + '/a.png'), objectRow(2, ROOM + '/b.png')] })
  const res = await handler(call())
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    processed: 2,
    removedObjects: 2,
    removedByPrefix: 0,
    skipped: 0,
    malformed: 0,
    failed: 0,
  })
})

/*
 * ここが一番効く。ゴミ箱に入れただけの画像は行が残っている。
 * その実体まで消すと、戻したのに開けないファイルになる。
 */
Deno.test('まだ行から参照されている実体は消さない', async () => {
  routes({
    queue: [objectRow(1, ROOM + '/keep.png'), objectRow(2, ROOM + '/gone.png')],
    referenced: [{ storage_path: ROOM + '/keep.png' }],
  })
  const res = await handler(call())
  const body = await res.json()
  assertEquals(body.skipped, 1)
  assertEquals(body.removedObjects, 1)

  // 消しに行ったのは gone.png だけ
  const removeCalls = net.calls.filter((u) => u.includes('/storage/v1/object/board-images'))
  assertEquals(removeCalls.length, 1)
})

Deno.test('形のおかしい予約は、消さずに捨てる', async () => {
  routes({ queue: [objectRow(1, 'どこかの/a.png'), objectRow(2, ROOM + '/b.png')] })
  const res = await handler(call())
  const body = await res.json()
  assertEquals(body.malformed, 1)
  assertEquals(body.processed, 1)
  assertEquals(body.removedObjects, 1)
})

Deno.test('フォルダごとの予約は、空になるまで消す', async () => {
  routes({
    queue: [{ id: 1, bucket: 'board-files', kind: 'prefix', path: ROOM + '/', attempts: 0 }],
    listPages: [[{ id: 'x1', name: 'a.pdf' }, { id: 'x2', name: 'b.pdf' }], []],
  })
  const res = await handler(call())
  const body = await res.json()
  assertEquals(body.removedByPrefix, 2)
  assertEquals(body.failed, 0)
})

/* フォルダの項目（id が null）は消せないので、混ざっても止まらないこと */
Deno.test('フォルダの項目は飛ばす', async () => {
  routes({
    queue: [{ id: 1, bucket: 'board-files', kind: 'prefix', path: ROOM + '/', attempts: 0 }],
    listPages: [[{ id: null, name: 'sub' }], []],
  })
  const body = await (await handler(call())).json()
  assertEquals(body.removedByPrefix, 0)
  assertEquals(body.failed, 0)
})

// ---------------------------------------------------------------------------
//  失敗したとき
// ---------------------------------------------------------------------------

Deno.test('Storage が失敗したら、予約を残して数える', async () => {
  routes({ queue: [objectRow(1, ROOM + '/a.png')], removeFails: true })
  const res = await handler(call())
  const body = await res.json()
  assertEquals(body.failed, 1)
  assertEquals(body.removedObjects, 0)

  // 予約は消さず、attempts を書き足しに行く
  const patches = net.calls.filter((u) => u.includes('/rest/v1/purge_queue'))
  assertEquals(patches.length >= 2, true)
})

Deno.test('台帳が読めなければ 500', async () => {
  net.reset()
  net.use((url) => {
    if (url.includes('/rest/v1/purge_queue')) {
      return new Response(JSON.stringify({ message: 'relation が見つかりません' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return restJson([])
  })
  const res = await handler(call())
  assertEquals(res.status, 500)
  await res.text()
})
