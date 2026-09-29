/*
 * board-ics（ボードの予定を購読 URL として配る）。
 *
 * 認証は URL に埋めた 32 桁のトークンだけ。だから見るのは次の 3 つ。
 *   1. 断るときは、理由の違いが応答に出ないこと（ボードの有無を漏らさない）
 *   2. 正しいトークンなら .ics が返り、ETag で 304 が成り立つこと
 *   3. DTSTAMP が中身の変わらないうちは動かないこと（動くと毎回全文を送る）
 */

import { assert, assertEquals } from 'jsr:@std/assert@1'
import { installFetchRouter, restJson, restRows, setFunctionEnv } from './helpers.ts'

setFunctionEnv()
// createClient より先に入れる（helpers.ts の installFetchRouter を参照）
const net = installFetchRouter()
const { handler, tokenOf, safeFileName, contentDisposition, stampFor, resetRateLimits } =
  await import('../board-ics/handler.ts')

const TOKEN = 'a'.repeat(32)
const ROOM_ID = '11111111-2222-3333-4444-555555555555'

const EVENT = {
  id: '99999999-8888-7777-6666-555555555555',
  title: '定例',
  description: '',
  start_at: '2026-09-14T01:00:00.000Z',
  end_at: '2026-09-14T02:00:00.000Z',
  all_day: false,
  kind: 'event',
  recurrence: 'none',
  recurrence_days: null,
  recurrence_week: null,
  recurrence_interval: null,
  recurrence_until: null,
  tags: [],
  updated_at: '2026-09-01T00:00:00.000Z',
}

/** PostgREST への問い合わせに、テーブルごとの行を返す */
function db(rows: Record<string, unknown[]> = {}) {
  resetRateLimits()
  net.reset()
  const table = (name: string, fallback: unknown[]) => rows[name] ?? fallback
  net.use((url) => {
    if (url.includes('/rest/v1/room_secrets')) {
      return restJson(table('room_secrets', [{ room_id: ROOM_ID }]))
    }
    if (url.includes('/rest/v1/event_overrides')) return restRows(url, table('event_overrides', []))
    if (url.includes('/rest/v1/events')) return restRows(url, table('events', [EVENT]))
    if (url.includes('/rest/v1/todos')) return restRows(url, table('todos', []))
    if (url.includes('/rest/v1/rooms')) return restJson(table('rooms', [{ name: 'みんなのボード' }]))
    return new Response('想定していない問い合わせ: ' + url, { status: 500 })
  })
}

function ask(path: string, init: RequestInit = {}): Request {
  return new Request('https://fn.example.test/functions/v1/board-ics' + path, init)
}

// ---------------------------------------------------------------------------
//  トークンの取り出し
// ---------------------------------------------------------------------------

Deno.test('トークンはパスからも ?token= からも読む', () => {
  assertEquals(tokenOf(new URL('https://x.test/board-ics/' + TOKEN + '.ics')), TOKEN)
  assertEquals(tokenOf(new URL('https://x.test/board-ics/' + TOKEN)), TOKEN)
  assertEquals(tokenOf(new URL('https://x.test/board-ics?token=' + TOKEN)), TOKEN)
})

Deno.test('形の違うトークンは受け取らない', () => {
  assertEquals(tokenOf(new URL('https://x.test/board-ics/short.ics')), null)
  assertEquals(tokenOf(new URL('https://x.test/board-ics/' + 'A'.repeat(32) + '.ics')), null)
  assertEquals(tokenOf(new URL('https://x.test/board-ics/' + 'a'.repeat(31) + '.ics')), null)
  assertEquals(tokenOf(new URL('https://x.test/board-ics/' + 'a'.repeat(33) + '.ics')), null)
  assertEquals(tokenOf(new URL('https://x.test/board-ics')), null)
})

Deno.test('ファイル名に使えない文字を落とす', () => {
  assertEquals(safeFileName('9月の予定'), '9月の予定')
  assertEquals(safeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j')
  assertEquals(safeFileName('   '), 'board')
  assertEquals(safeFileName(''), 'board')
  assertEquals(safeFileName('あ'.repeat(100)).length, 60)
})

/*
 * ここは実際に壊れていたところ。ヘッダの値は Latin-1 までしか入らないので、
 * ボード名をそのまま filename= に入れると Response の構築で例外になり、
 * catch が「知らないトークン」と同じ 404 に丸めてしまう。
 * つまり日本語名のボードでは購読 URL が全部 404 を返していた。
 */
Deno.test('日本語のボード名でも、ヘッダに入れられる形にする', () => {
  const line = contentDisposition('みんなのボード')

  // Latin-1 に収まる（ここが false なら Response の構築で落ちる）
  assertEquals(/^[\x20-\xff]*$/.test(line), true, line)
  // 読める側には UTF-8 で渡す
  assert(line.includes("filename*=UTF-8''"), line)
  assert(line.includes(encodeURIComponent('みんなのボード')), line)
  // 読めない相手にも ASCII の控えを残す
  assert(line.includes('filename="'), line)

  // ヘッダとして実際に組み立てられること
  new Response('x', { headers: { 'Content-Disposition': line } })
})

/*
 * 60 文字で切るとき、UTF-16 の単位で切ると絵文字（サロゲートペア）の片割れが残る。
 * encodeURIComponent は片割れを受け付けず URIError を投げるので、上と同じく
 * 購読 URL が黙って 404 になっていた。ボード名は 100 文字まで入る。
 */
Deno.test('絵文字の途中では切らない', () => {
  const name = 'あ'.repeat(59) + '😀' + 'い'
  const safe = safeFileName(name)
  assertEquals(safe, 'あ'.repeat(59) + '😀')
  assertEquals(safe.isWellFormed(), true)

  const line = contentDisposition(name)
  assert(line.includes(encodeURIComponent('😀.ics')), line)
  new Response('x', { headers: { 'Content-Disposition': line } })
})

Deno.test('ASCII の名前はそのまま出す', () => {
  const line = contentDisposition('Sprint 42')
  assert(line.includes('filename="Sprint 42.ics"'), line)
  assert(line.includes("filename*=UTF-8''Sprint%2042.ics"), line)

  // 名前が全部落ちても空のファイル名にしない
  assert(contentDisposition('　').includes('filename="board.ics"'))
  assert(contentDisposition('').includes('filename="board.ics"'))
})

// ---------------------------------------------------------------------------
//  DTSTAMP（ETag が成り立つかどうかを決めている）
// ---------------------------------------------------------------------------

Deno.test('DTSTAMP は今日の 0:00 か、中身の最終更新の遅いほう', () => {
  const now = new Date('2026-09-10T05:00:00.000Z') // JST 14:00
  const todayStart = new Date('2026-09-10T00:00:00+09:00')

  // 更新が古ければ今日の 0:00 に留まる（＝日中は動かない ＝ ETag が効く）
  assertEquals(stampFor(['2026-09-01T00:00:00.000Z'], now).getTime(), todayStart.getTime())
  assertEquals(stampFor([], now).getTime(), todayStart.getTime())
  assertEquals(stampFor([null, undefined], now).getTime(), todayStart.getTime())

  // さっき更新されたなら、そちらを使う
  const justNow = '2026-09-10T04:59:00.000Z'
  assertEquals(stampFor([justNow], now).toISOString(), justNow)

  // 読めない値は無視する
  assertEquals(stampFor(['まだ'], now).getTime(), todayStart.getTime())
})

// ---------------------------------------------------------------------------
//  断り方（すべて同じ 404 であること）
// ---------------------------------------------------------------------------

Deno.test('GET / HEAD 以外は 405', async () => {
  db()
  const res = await handler(ask('/' + TOKEN + '.ics', { method: 'POST' }))
  assertEquals(res.status, 405)
  assertEquals(res.headers.get('Allow'), 'GET, HEAD')
  await res.text()
})

/*
 * ここが一番効く。「形が違う」「知らないトークン」で応答が少しでも違うと、
 * 総当たりに手がかりを与えてしまう。
 */
Deno.test('断る理由が違っても、応答はバイト単位で同じ', async () => {
  db({ room_secrets: [] })
  const bad = await handler(ask('/short.ics'))
  const unknown = await handler(ask('/' + 'b'.repeat(32) + '.ics'))

  assertEquals(bad.status, 404)
  assertEquals(bad.status, unknown.status)
  assertEquals(await bad.text(), await unknown.text())
  assertEquals([...bad.headers].sort(), [...unknown.headers].sort())
})

Deno.test('ボードが消えていても 404', async () => {
  db({ rooms: [] })
  const res = await handler(ask('/' + TOKEN + '.ics'))
  assertEquals(res.status, 404)
  await res.text()
})

Deno.test('DB が落ちていても 404（中の失敗を外に出さない）', async () => {
  db()
  net.use(() => new Response('connection refused', { status: 500 }))
  const res = await handler(ask('/' + TOKEN + '.ics'))
  assertEquals(res.status, 404)
  assertEquals((await res.text()).includes('refused'), false)
})

// ---------------------------------------------------------------------------
//  正常系
// ---------------------------------------------------------------------------

Deno.test('正しいトークンなら .ics を返す', async () => {
  db()
  const res = await handler(ask('/' + TOKEN + '.ics'))
  assertEquals(res.status, 200)
  assertEquals(res.headers.get('Content-Type'), 'text/calendar; charset=utf-8')
  assertEquals(res.headers.get('Cache-Control'), 'private, max-age=900')
  assertEquals(res.headers.get('X-Robots-Tag'), 'noindex')
  assert(res.headers.get('ETag'))

  // 日本語のボード名でも 200 で返ること（filename= に入れて落ちていた）
  const disposition = res.headers.get('Content-Disposition')!
  assert(disposition.includes(encodeURIComponent('みんなのボード')), disposition)

  const body = await res.text()
  assert(body.startsWith('BEGIN:VCALENDAR'))
  assert(body.includes('SUMMARY:定例'), body)
  assert(body.includes('X-WR-CALNAME:みんなのボード'), body)
})

Deno.test('HEAD は本文を返さない', async () => {
  db()
  const res = await handler(ask('/' + TOKEN + '.ics', { method: 'HEAD' }))
  assertEquals(res.status, 200)
  assertEquals(await res.text(), '')
  assert(res.headers.get('ETag'))
})

Deno.test('中身が変わらなければ 304 を返す', async () => {
  db()
  const first = await handler(ask('/' + TOKEN + '.ics'))
  const etag = first.headers.get('ETag')!
  await first.text()

  const again = await handler(ask('/' + TOKEN + '.ics', { headers: { 'if-none-match': etag } }))
  assertEquals(again.status, 304)
  assertEquals(await again.text(), '')
})

/*
 * PostgREST は 1 回に 1000 行までしか返さない。.limit(3000) を付けていても
 * その上限は超えられず、予定が 1000 件を超えるボードでは、残りが購読先に
 * 黙って出なかった。
 */
Deno.test('予定が 1000 件を超えても、全部配る', async () => {
  const events = Array.from({ length: 1200 }, (_, i) => ({
    ...EVENT,
    id: `99999999-8888-7777-6666-${String(i).padStart(12, '0')}`,
  }))
  db({ events })
  const res = await handler(ask('/' + TOKEN + '.ics'))
  assertEquals(res.status, 200)
  assertEquals((await res.text()).split('BEGIN:VEVENT').length - 1, 1200)
})

/*
 * 例外行は room_id で絞って取っているが、service_role は RLS を素通りするので
 * 「取ってきた予定に属するか」をアプリ側で確かめ直している。その確認が効いているか。
 */
Deno.test('他の予定の例外行は混ぜない', async () => {
  const stray = {
    event_id: '00000000-0000-0000-0000-000000000000',
    occurrence_date: '2026-09-14',
    canceled: true,
    title: '乗っ取り',
    description: null,
    start_at: null,
    end_at: null,
    all_day: null,
    color: null,
    remind_minutes: null,
    tags: null,
    created_at: '2026-09-01T00:00:00.000Z',
  }
  db({ event_overrides: [stray] })
  const res = await handler(ask('/' + TOKEN + '.ics'))
  assertEquals(res.status, 200)
  assertEquals((await res.text()).includes('乗っ取り'), false)
})

Deno.test('取りに来すぎれば 429', async () => {
  db()
  for (let i = 0; i < 60; i++) {
    const res = await handler(ask('/' + TOKEN + '.ics'))
    assertEquals(res.status, 200, i + ' 回目')
    await res.text()
  }
  const over = await handler(ask('/' + TOKEN + '.ics'))
  assertEquals(over.status, 429)
  assertEquals(over.headers.get('Retry-After'), '600')
  await over.text()
})
