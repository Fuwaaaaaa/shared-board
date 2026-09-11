/*
 * pg_cron から呼ばれる関数の入口の認証。
 *
 * ここが抜けると send-reminders / purge-storage は
 * インターネットの誰からでも叩ける関数になる（config.toml で verify_jwt = false）。
 * 「合言葉が無いときに通してしまわないこと」を一番に見る。
 */

import { assertEquals } from 'jsr:@std/assert@1'
import { isCronCaller } from '../_shared/cronAuth.ts'

const SECRET = 'test-secret-0123456789abcdef'

function withSecret(value: string | null): Request {
  const headers = new Headers()
  if (value !== null) headers.set('x-cron-secret', value)
  return new Request('https://example.test/', { headers })
}

function setSecret(value: string | null) {
  if (value === null) Deno.env.delete('CRON_SHARED_SECRET')
  else Deno.env.set('CRON_SHARED_SECRET', value)
}

Deno.test('合言葉が合えば通す', async () => {
  setSecret(SECRET)
  assertEquals(await isCronCaller(withSecret(SECRET)), true)
})

Deno.test('合言葉が違えば断る', async () => {
  setSecret(SECRET)
  assertEquals(await isCronCaller(withSecret('test-secret-0123456789abcdeg')), false)
})

Deno.test('ヘッダが無ければ断る', async () => {
  setSecret(SECRET)
  assertEquals(await isCronCaller(withSecret(null)), false)
  assertEquals(await isCronCaller(withSecret('')), false)
})

/*
 * 一番効く回帰テスト。CRON_SHARED_SECRET を設定し忘れたまま関数を配ると、
 * 「空文字 === 空文字」で誰でも通る作りになりうる。ここで塞いでおく。
 */
Deno.test('合言葉が未設定なら誰も通さない', async () => {
  setSecret(null)
  assertEquals(await isCronCaller(withSecret('')), false)
  assertEquals(await isCronCaller(withSecret('anything')), false)
  assertEquals(await isCronCaller(withSecret(null)), false)
})

/* 長さの違うものを渡しても、比較の前に SHA-256 で 32 バイトへ揃う */
Deno.test('長さが違っても落ちない', async () => {
  setSecret(SECRET)
  assertEquals(await isCronCaller(withSecret('x')), false)
  assertEquals(await isCronCaller(withSecret('x'.repeat(10_000))), false)
})

Deno.test('前方一致では通らない', async () => {
  setSecret(SECRET)
  assertEquals(await isCronCaller(withSecret(SECRET.slice(0, -1))), false)
  assertEquals(await isCronCaller(withSecret(SECRET + 'x')), false)
})
