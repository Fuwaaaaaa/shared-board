/*
 * fetch-ics（外部カレンダーの取得中継）。
 *
 * この関数は「利用者の指定した URL をサーバーが取りに行く」ので、
 * 壊れると SSRF の入口になる。見るのは主に次の 3 つ。
 *   1. ログインしていない呼び出しを通さないこと
 *   2. 内側を向いた宛先へ行かないこと（転送のあとも）
 *   3. 上流が失敗したときに、その理由を呼び出し元へ漏らさないこと
 */

import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@1'
import { authedJwt, jwt, restJson, setFunctionEnv, stubDns, stubFetch } from './helpers.ts'

setFunctionEnv()
const {
  handler,
  isBlockedHost,
  isBlockedIPv4,
  isBlockedIPv6,
  callerSub,
  normalizeScheme,
  validateTarget,
  readLimited,
  resetRateLimits,
} = await import('../fetch-ics/handler.ts')

const FEED = 'https://cal.example.test/board.ics'
const DNS = { 'cal.example.test': ['93.184.216.34'] }
const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n'

/** 登録済みフィードの問い合わせに答えつつ、上流の応答は差し替える */
function stubBoth(
  upstream: (url: string) => Response | Promise<Response>,
  feeds: string[] = [FEED],
) {
  return stubFetch((url) => {
    if (url.includes('/rest/v1/calendar_feeds')) return restJson(feeds.map((u) => ({ url: u })))
    return upstream(url)
  })
}

function get(target: string | null, token: string | null = authedJwt()): Request {
  const url = new URL('https://fn.example.test/fetch-ics')
  if (target !== null) url.searchParams.set('url', target)
  const headers = new Headers()
  if (token !== null) headers.set('Authorization', 'Bearer ' + token)
  return new Request(url, { headers })
}

// ---------------------------------------------------------------------------
//  宛先の検査（ここが SSRF の壁）
// ---------------------------------------------------------------------------

Deno.test('内側を向いたホスト名を弾く', () => {
  for (const host of ['localhost', 'db.localhost', 'kong.internal', 'printer.local', '']) {
    assertEquals(isBlockedHost(host), true, host)
  }
  for (const host of ['example.com', 'calendar.google.com', '93.184.216.34']) {
    assertEquals(isBlockedHost(host), false, host)
  }
})

Deno.test('予約された IPv4 を弾く', () => {
  const blocked = [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '203.0.113.5',
    '224.0.0.1',
    '255.255.255.255',
  ]
  for (const ip of blocked) assertEquals(isBlockedIPv4(ip), true, ip)

  // 見た目が近いだけの外向きアドレスは通す
  for (const ip of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '100.63.0.1', '101.64.0.1']) {
    assertEquals(isBlockedIPv4(ip), false, ip)
  }
})

/* 169.254.169.254 はクラウドのメタデータ。ここが抜けると鍵を読まれる */
Deno.test('メタデータのアドレスは、埋め込みや別表記でも弾く', () => {
  assertEquals(isBlockedIPv4('169.254.169.254'), true)
  assertEquals(isBlockedIPv6('::ffff:169.254.169.254'), true)
  assertEquals(isBlockedIPv6('64:ff9b::169.254.169.254'), true)
  assertEquals(isBlockedHost('[::ffff:169.254.169.254]'), true)
})

Deno.test('予約された IPv6 を弾く', () => {
  const blocked = ['::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1']
  for (const ip of blocked) assertEquals(isBlockedIPv6(ip), true, ip)
  for (const ip of ['2001:4860:4860::8888', '2606:4700:4700::1111']) {
    assertEquals(isBlockedIPv6(ip), false, ip)
  }
})

Deno.test('webcal: は https: として読む', () => {
  assertEquals(normalizeScheme('webcal://example.com/a.ics'), 'https://example.com/a.ics')
  assertEquals(normalizeScheme('WEBCAL://example.com/a.ics'), 'https://example.com/a.ics')
  assertEquals(normalizeScheme('https://example.com/a.ics'), 'https://example.com/a.ics')
})

Deno.test('スキーム・ユーザー名・ポートで断る', async () => {
  const dns = stubDns(DNS)
  try {
    assertNotEquals(await validateTarget(new URL('ftp://cal.example.test/a.ics')), null)
    assertNotEquals(await validateTarget(new URL('https://u:p@cal.example.test/a.ics')), null)
    assertNotEquals(await validateTarget(new URL('https://cal.example.test:8080/a.ics')), null)
    assertEquals(await validateTarget(new URL('https://cal.example.test:443/a.ics')), null)
    assertEquals(await validateTarget(new URL('https://cal.example.test/a.ics')), null)
  } finally {
    dns.restore()
  }
})

Deno.test('名前が内側へ解決されたら断る', async () => {
  const dns = stubDns({
    'evil.example.test': ['10.0.0.5'],
    'mixed.example.test': ['93.184.216.34', '127.0.0.1'],
  })
  try {
    assertNotEquals(await validateTarget(new URL('https://evil.example.test/a.ics')), null)
    // 1 つでも内側を向いていれば断る
    assertNotEquals(await validateTarget(new URL('https://mixed.example.test/a.ics')), null)
    // 引けない名前も断る（fail-closed）
    assertNotEquals(await validateTarget(new URL('https://nx.example.test/a.ics')), null)
  } finally {
    dns.restore()
  }
})

// ---------------------------------------------------------------------------
//  認証
// ---------------------------------------------------------------------------

Deno.test('JWT から呼び出した人を読む', () => {
  const now = Math.floor(Date.now() / 1000)
  assertEquals(callerSub(new Request('https://x.test/')), null)
  assertEquals(callerSub(get(FEED, jwt({ role: 'anon', sub: 'a', exp: now + 60 }))), null)
  assertEquals(callerSub(get(FEED, jwt({ role: 'authenticated', sub: 'a', exp: now - 60 }))), null)
  assertEquals(callerSub(get(FEED, jwt({ role: 'authenticated', sub: '', exp: now + 60 }))), null)
  assertEquals(callerSub(get(FEED, jwt({ role: 'authenticated', sub: 'a', exp: now + 60 }))), 'a')
  assertEquals(callerSub(get(FEED, 'not-a-jwt')), null)
})

Deno.test('ログインしていなければ 401', async () => {
  resetRateLimits()
  assertEquals((await handler(get(FEED, null))).status, 401)
  const now = Math.floor(Date.now() / 1000)
  const anon = jwt({ role: 'anon', sub: 'a', exp: now + 60 })
  assertEquals((await handler(get(FEED, anon))).status, 401)
})

Deno.test('GET と OPTIONS 以外は 405', async () => {
  resetRateLimits()
  const res = await handler(new Request('https://fn.example.test/fetch-ics', { method: 'POST' }))
  assertEquals(res.status, 405)
})

Deno.test('OPTIONS には設定した SITE_URL だけを許す', async () => {
  const res = await handler(new Request('https://fn.example.test/fetch-ics', { method: 'OPTIONS' }))
  assertEquals(res.status, 200)
  assertEquals(res.headers.get('Access-Control-Allow-Origin'), 'https://board.example.test')
})

// ---------------------------------------------------------------------------
//  入口の流れ
// ---------------------------------------------------------------------------

Deno.test('url が無ければ 400', async () => {
  resetRateLimits()
  assertEquals((await handler(get(null))).status, 400)
  assertEquals((await handler(get('http://['))).status, 400)
})

Deno.test('登録されていないカレンダーは 403', async () => {
  resetRateLimits()
  const net = stubBoth(() => new Response(ICS), [])
  try {
    const res = await handler(get(FEED))
    assertEquals(res.status, 403)
    // 上流へは行っていない
    assertEquals(net.calls.some((u) => u.startsWith(FEED)), false)
  } finally {
    net.restore()
  }
})

Deno.test('登録済みなら取ってきて返す', async () => {
  resetRateLimits()
  const dns = stubDns(DNS)
  const net = stubBoth(() => new Response(ICS, { headers: { 'Content-Type': 'text/calendar' } }))
  try {
    const res = await handler(get(FEED))
    assertEquals(res.status, 200)
    assertEquals(res.headers.get('Content-Type'), 'text/calendar; charset=utf-8')
    assertEquals(res.headers.get('Cache-Control'), 'private, max-age=900')
    assertEquals(await res.text(), ICS)
  } finally {
    net.restore()
    dns.restore()
  }
})

Deno.test('webcal:// で登録されていても取れる', async () => {
  resetRateLimits()
  const dns = stubDns(DNS)
  const net = stubBoth(() => new Response(ICS), ['webcal://cal.example.test/board.ics'])
  try {
    const res = await handler(get(FEED))
    assertEquals(res.status, 200)
    await res.text()
  } finally {
    net.restore()
    dns.restore()
  }
})

// ---------------------------------------------------------------------------
//  外部通信が失敗したとき
// ---------------------------------------------------------------------------

Deno.test('上流が失敗しても、理由は返さず 502', async () => {
  resetRateLimits()
  const dns = stubDns(DNS)
  const net = stubBoth(() => new Response('secret internal error', { status: 500 }))
  try {
    const res = await handler(get(FEED))
    assertEquals(res.status, 502)
    const body = await res.text()
    assertEquals(body.includes('500'), false)
    assertEquals(body.includes('secret'), false)
  } finally {
    net.restore()
    dns.restore()
  }
})

Deno.test('つながらなかったときも 502', async () => {
  resetRateLimits()
  const dns = stubDns(DNS)
  const net = stubBoth(() => Promise.reject(new TypeError('connection refused')))
  try {
    const res = await handler(get(FEED))
    assertEquals(res.status, 502)
    assertEquals((await res.text()).includes('refused'), false)
  } finally {
    net.restore()
    dns.restore()
  }
})

Deno.test('カレンダーでない中身は 415', async () => {
  resetRateLimits()
  const dns = stubDns(DNS)
  const net = stubBoth(() => new Response('<html>ログインしてください</html>'))
  try {
    const res = await handler(get(FEED))
    assertEquals(res.status, 415)
    await res.text()
  } finally {
    net.restore()
    dns.restore()
  }
})

/* 一度検査を通ったあとに内側へ転送させる、という手を塞げているか */
Deno.test('内側への転送は追わない', async () => {
  resetRateLimits()
  const dns = stubDns(DNS)
  const net = stubBoth((url) => {
    if (url.startsWith(FEED)) {
      const headers = { Location: 'http://169.254.169.254/latest/meta-data/' }
      return new Response(null, { status: 302, headers })
    }
    return new Response('metadata!')
  })
  try {
    const res = await handler(get(FEED))
    assertEquals(res.status, 400)
    assertEquals(net.calls.some((u) => u.includes('169.254')), false)
    await res.text()
  } finally {
    net.restore()
    dns.restore()
  }
})

Deno.test('転送が多すぎれば断る', async () => {
  resetRateLimits()
  const dns = stubDns(DNS)
  const net = stubBoth(() => new Response(null, { status: 302, headers: { Location: FEED } }))
  try {
    const res = await handler(get(FEED))
    assertEquals(res.status, 400)
    await res.text()
  } finally {
    net.restore()
    dns.restore()
  }
})

Deno.test('同じ人が続けて叩けば 429', async () => {
  resetRateLimits()
  const dns = stubDns(DNS)
  const net = stubBoth(() => new Response(ICS))
  const token = authedJwt('busy-user')
  try {
    for (let i = 0; i < 30; i++) {
      const res = await handler(get(FEED, token))
      assertEquals(res.status, 200, i + ' 回目')
      await res.text()
    }
    const over = await handler(get(FEED, token))
    assertEquals(over.status, 429)
    await over.text()
  } finally {
    net.restore()
    dns.restore()
  }
})

// ---------------------------------------------------------------------------
//  大きさ
// ---------------------------------------------------------------------------

Deno.test('5MB を超える応答は読まない', async () => {
  const big = new Uint8Array(6 * 1024 * 1024)
  assertEquals(await readLimited(new Response(big)), null)

  // Content-Length だけ大きいと言ってくる相手も、読む前に止める
  const lying = new Response('小さい', {
    headers: { 'Content-Length': String(9 * 1024 * 1024) },
  })
  assertEquals(await readLimited(lying), null)

  const small = await readLimited(new Response(ICS))
  assert(small !== null && small.includes('VCALENDAR'))
})
