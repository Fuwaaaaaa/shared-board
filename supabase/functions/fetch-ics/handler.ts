/*
 * 外部カレンダー（.ics 公開 URL）を取得して返すだけの中継。
 *
 * Google カレンダーなどの .ics は CORS を許可していないため、
 * ブラウザから直接読めない。ここを経由して読み込む。
 *
 * デプロイ:
 *   npx supabase functions deploy fetch-ics
 *   （JWT を検証する設定は supabase/config.toml に verify_jwt = true として
 *     書いてある。コマンドの付け忘れで検証が外れないよう、宣言で固定している）
 *
 * ここは「利用者が指定した URL をサーバーが取りに行く」ので、SSRF の入口になり得る。
 * 守りは次のとおり。
 *   1. 認証: Authorization の JWT が role=authenticated であること（署名検証は
 *      Supabase の verify_jwt に任せ、ここでは payload だけ読む。anon key は role=anon
 *      なので 401 になる）。
 *   2. 流量: 利用者（sub）ごとに毎分 30 回。isolate 内の Map なので目安でしかないが、
 *      1 人が中継として使い倒すのは止められる。
 *   3. 宛先: http(s) だけ、ユーザー名つき・80/443 以外のポートは拒否。localhost 系と
 *      予約アドレス（IPv4 / IPv6、埋め込み IPv4 を含む）を拒否。ホスト名は A / AAAA を
 *      解決して、解決先が 1 つでも予約アドレスなら拒否。解決できなければ拒否。
 *   4. 転送: redirect は自前で追い（最大 3 ホップ）、転送先にも同じ検査をかける。
 *   5. 大きさ: 5MB を超えたら読むのをやめる。
 *   6. 中身: BEGIN:VCALENDAR を含まない応答は返さない（汎用の中継として使わせない）。
 *   7. 宛先の出どころ: 呼び出した人が見られるボードの calendar_feeds に登録済みで、
 *      止めていない URL だけを取りに行く（RLS 越しに引くので、他人のボードの購読先は
 *      使えない）。
 *   8. 応答: 失敗の理由は返さない。到達できたか・HTTP のステータス・エラーの種類は
 *      そのまま内部ネットワークの探索に使えるため、ログにだけ残す。
 *
 * 残るリスク:
 *   - 外向きの踏み台。7. は「登録していない URL」を断るだけで、匿名でもボードを作って
 *     フィードを登録すれば、公開された好きな URL を取りに行かせられる。宛先（3.）と
 *     中身（6.）の検査で内側には届かず、カレンダー以外の中身も返さないが、
 *     外へ GET を投げさせることは流量（2.）の範囲でできる。
 *   - DNS rebinding。ここで名前を解決して検査したあと、fetch が改めて解決するので、
 *     その間に応答を変えられると内側へ届く。Supabase の Edge Runtime は外部ネットワーク
 *     上で動くため、到達できる「内側」は限られるが、ゼロではない。
 *   - Deno.resolveDns が使えない環境では、ホスト名の URL をすべて拒否する（fail-closed）。
 *     IP を直接書いた URL は解決なしで検査できるので通る。
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

/**
 * 許可するオリジン。
 *
 * SITE_URL（send-reminders と同じ環境変数）に限定する。認証は Authorization
 * ヘッダなので '*' でも CSRF にはならないが、万一トークンを持ち出せた場合に、
 * 任意のページからこの中継を叩けてしまう。
 *
 * 未設定でも '*' には戻さず、開発用の localhost だけを許す。戻していたころは、
 * 設定し忘れたまま公開しても動いてしまうので、'*' のまま運用が続いても
 * 誰も気づけなかった。公開したものが CORS で弾かれれば、そこで気づける。
 */
const SITE_URL = (Deno.env.get('SITE_URL') ?? '').replace(/\/+$/, '')
const DEV_ORIGIN = 'http://localhost:5173'
const ALLOW_ORIGIN = SITE_URL || DEV_ORIGIN

if (!SITE_URL) {
  console.warn(
    `[fetch-ics] SITE_URL が未設定です。${DEV_ORIGIN} からの呼び出しだけを許します。` +
      '公開したものから使うには SITE_URL を設定してください。',
  )
}

const CORS = {
  'Access-Control-Allow-Origin': ALLOW_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  Vary: 'Origin, Authorization',
}

/** 5MB を超える応答は読まない */
const MAX_BYTES = 5 * 1024 * 1024
/** 転送を追う回数 */
const MAX_HOPS = 3
/** 1 人あたり毎分の回数 */
const RATE_LIMIT_PER_MINUTE = 30

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

/** 宛先が検査で弾かれたとき（502 ではなく 400 で返す） */
class TargetError extends Error {}

// ---------------------------------------------------------------------------
//  認証
// ---------------------------------------------------------------------------

function base64UrlDecode(input: string): string {
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4)
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/**
 * 呼び出した利用者の id（JWT の sub）。ログイン済みでなければ null。
 *
 * 署名は検証しない（verify_jwt を有効にしてデプロイしているので、ここに届く JWT は
 * Supabase が検証済み）。ここで見るのは role と有効期限だけ。
 */
export function callerSub(req: Request): string | null {
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ')) return null

  const parts = auth.slice('Bearer '.length).trim().split('.')
  if (parts.length !== 3) return null

  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as Record<string, unknown>
    if (payload.role !== 'authenticated') return null
    if (typeof payload.sub !== 'string' || payload.sub === '') return null
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null
    return payload.sub
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
//  流量（isolate 内。再起動でリセットされる目安の値）
// ---------------------------------------------------------------------------

const hits = new Map<string, { minute: number; count: number }>()

function rateLimited(sub: string): boolean {
  const minute = Math.floor(Date.now() / 60_000)
  const entry = hits.get(sub)

  if (!entry || entry.minute !== minute) {
    // 古い分を掃除してから記録する（増え続けないように）
    if (hits.size > 5_000) {
      for (const [key, value] of hits) if (value.minute !== minute) hits.delete(key)
    }
    hits.set(sub, { minute, count: 1 })
    return false
  }

  entry.count += 1
  return entry.count > RATE_LIMIT_PER_MINUTE
}

/** テスト用。isolate に溜めた回数を捨てる（本番の経路からは呼ばれない） */
export function resetRateLimits(): void {
  hits.clear()
}

// ---------------------------------------------------------------------------
//  宛先の検査
// ---------------------------------------------------------------------------

/** "a.b.c.d" を 4 つの数に。形が違えば null */
function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  return parts.every((n) => n <= 255) ? parts : null
}

/** 予約・内部向けの IPv4 か（IPv4 でなければ false） */
export function isBlockedIPv4(host: string): boolean {
  const p = parseIPv4(host)
  if (!p) return false
  const [a, b, c] = p

  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10（CGNAT）
  if (a === 127) return true // 127.0.0.0/8
  if (a === 169 && b === 254) return true // 169.254.0.0/16（リンクローカル・メタデータ）
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true // 192.0.2.0/24（TEST-NET-1）
  if (a === 192 && b === 88 && c === 99) return true // 192.88.99.0/24（6to4 中継）
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15（ベンチマーク）
  if (a === 198 && b === 51 && c === 100) return true // 198.51.100.0/24（TEST-NET-2）
  if (a === 203 && b === 0 && c === 113) return true // 203.0.113.0/24（TEST-NET-3）
  if (a >= 224) return true // 224.0.0.0/4（マルチキャスト）・240.0.0.0/4（予約・ブロードキャスト）
  return false
}

/** IPv6 を 16bit × 8 に。形が違えば null。末尾の IPv4 表記（::ffff:1.2.3.4）も受ける */
function parseIPv6(host: string): number[] | null {
  let h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  const zone = h.indexOf('%')
  if (zone >= 0) h = h.slice(0, zone)
  if (!/^[0-9a-fA-F:.]+$/.test(h) || !h.includes(':')) return null

  const lastColon = h.lastIndexOf(':')
  if (h.includes('.', lastColon)) {
    const v4 = parseIPv4(h.slice(lastColon + 1))
    if (!v4) return null
    const hi = ((v4[0] << 8) | v4[1]).toString(16)
    const lo = ((v4[2] << 8) | v4[3]).toString(16)
    h = `${h.slice(0, lastColon + 1)}${hi}:${lo}`
  }

  const halves = h.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 2 ? missing < 0 : missing !== 0) return null

  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail]
  const out: number[] = []
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    out.push(parseInt(g, 16))
  }
  return out
}

/** 予約・内部向けの IPv6 か（IPv6 でなければ false）。IPv4 を埋め込んだ形は中の IPv4 で判定 */
export function isBlockedIPv6(host: string): boolean {
  const g = parseIPv6(host)
  if (!g) return false

  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  const leadingZeros = (n: number) => g.slice(0, n).every((x) => x === 0)

  if (leadingZeros(8)) return true // ::
  if (leadingZeros(7) && g[7] === 1) return true // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7（ULA）
  if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10（リンクローカル）
  if ((g[0] & 0xffc0) === 0xfec0) return true // fec0::/10（サイトローカル・廃止）
  if ((g[0] & 0xff00) === 0xff00) return true // ff00::/8（マルチキャスト）
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true // 2001:db8::/32（文書用）
  if (g[0] === 0x2002) return isBlockedIPv4(v4(g[1], g[2])) // 2002::/16（6to4）
  if (leadingZeros(5) && g[5] === 0xffff) return isBlockedIPv4(v4(g[6], g[7])) // ::ffff:0:0/96
  if (leadingZeros(6)) return isBlockedIPv4(v4(g[6], g[7])) // ::/96（IPv4 互換・廃止）
  if (g[0] === 0x0064 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isBlockedIPv4(v4(g[6], g[7])) // 64:ff9b::/96（NAT64）
  }
  return false
}

/** 名前だけで弾けるもの。IP 表記ならアドレスの検査もここで済ませる */
export function isBlockedHost(hostname: string): boolean {
  let host = hostname.toLowerCase().replace(/\.$/, '')
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)

  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.internal') || host.endsWith('.local')) return true
  if (isBlockedIPv4(host) || isBlockedIPv6(host)) return true
  return false
}

/** IP を直接書いた URL か（ホスト名の解決が要らない） */
function isIpLiteral(hostname: string): boolean {
  return parseIPv4(hostname) !== null || hostname.startsWith('[')
}

/** ホスト名を A / AAAA で解決する。解決できなければ空（→ 呼び元で拒否） */
async function resolveAll(host: string): Promise<string[]> {
  if (typeof Deno.resolveDns !== 'function') return []
  const results = await Promise.allSettled([
    Deno.resolveDns(host, 'A'),
    Deno.resolveDns(host, 'AAAA'),
  ])
  const addrs: string[] = []
  for (const r of results) if (r.status === 'fulfilled') addrs.push(...r.value)
  return addrs
}

/** 宛先を検査する。問題があれば理由の文言、なければ null */
export async function validateTarget(url: URL): Promise<string | null> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'https の URL を指定してください'
  }
  if (url.username !== '' || url.password !== '') {
    return 'ユーザー名つきの URL は使えません'
  }
  // 既定のポートなら url.port は空文字
  if (url.port !== '' && url.port !== '80' && url.port !== '443') {
    return 'このポートには接続できません'
  }

  const host = url.hostname
  if (isBlockedHost(host)) return 'この宛先は取得できません'
  if (isIpLiteral(host)) return null

  let addrs: string[]
  try {
    addrs = await resolveAll(host)
  } catch {
    addrs = []
  }
  if (addrs.length === 0) return 'この宛先は取得できません'
  for (const a of addrs) {
    if (isBlockedIPv4(a) || isBlockedIPv6(a)) return 'この宛先は取得できません'
  }
  return null
}

/** webcal:// でコピーされることが多いので https に読み替える（URL に組み立てる前に） */
export function normalizeScheme(raw: string): string {
  return raw.replace(/^webcal:/i, 'https:')
}

/** 転送を自前で追いながら取得する。転送先にも同じ検査をかける */
async function fetchWithChecks(start: URL): Promise<Response> {
  let current = start

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const problem = await validateTarget(current)
    if (problem) throw new TargetError(problem)

    const res = await fetch(current.toString(), {
      headers: { Accept: 'text/calendar, text/plain, */*' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    })

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('Location')
      await res.body?.cancel()
      if (!location) throw new TargetError('転送先が分かりません')
      if (hop === MAX_HOPS) throw new TargetError('転送が多すぎます')
      try {
        current = new URL(normalizeScheme(location), current)
      } catch {
        throw new TargetError('転送先の URL が正しくありません')
      }
      continue
    }

    return res
  }

  throw new TargetError('転送が多すぎます')
}

/** 本文を 5MB まで読む。超えたら途中でやめて null を返す */
export async function readLimited(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get('Content-Length') ?? '0')
  if (declared > MAX_BYTES) {
    await res.body?.cancel()
    return null
  }
  if (!res.body) return ''

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8').decode(merged)
}

// ---------------------------------------------------------------------------
//  登録済みのカレンダーか
// ---------------------------------------------------------------------------

/**
 * 取りに行こうとしている URL が、呼び出した人の見られるボードに登録されていて、
 * 止められていないか。
 *
 * calendar_feeds は RLS で can_access_room の行しか読めないので、呼び出した人の
 * トークンでそのまま引けば「その人が見られるボードに登録済みか」だけが分かる。
 * 他の人のボードの購読先を、URL を書き換えて取りに行かせることはできない。
 *
 * ただし、これで止められるのは「ボードに登録していない URL」だけ。
 * 匿名でもボードを作ってフィードを登録できるので、その手間をかければ誰でも
 * 好きな URL を取りに行かせられる（外向きの踏み台になりうる）。そこを抑えているのは
 * 宛先の検査・流量・中身の検査のほうで、ここは入口を 1 つ狭めているだけ。
 *
 * URL は両側とも normalizeScheme と URL の正規化を通してから比べる
 * （webcal: と https: の違いや、末尾のスラッシュの有無で落とさないため）。
 */
async function isRegisteredFeed(req: Request, target: URL): Promise<boolean> {
  if (SUPABASE_URL === '' || ANON_KEY === '') {
    console.error('fetch-ics: SUPABASE_URL / SUPABASE_ANON_KEY が読めません')
    return false
  }

  const auth = req.headers.get('Authorization') ?? ''
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: auth } },
  })

  // 止めたフィードは画面も取りに来ない。止めたあとも中継に使えると、止めた意味がない
  const { data, error } = await client.from('calendar_feeds').select('url').eq('enabled', true)
  if (error) {
    console.error('fetch-ics: calendar_feeds を読めませんでした', error.message)
    return false
  }

  for (const row of data ?? []) {
    try {
      if (new URL(normalizeScheme(String(row.url).trim())).href === target.href) return true
    } catch {
      // 壊れた URL が入っていても、ここで落とさない
    }
  }
  return false
}

// ---------------------------------------------------------------------------
//  入口
// ---------------------------------------------------------------------------

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'GET') return json(405, { error: 'GET だけ受け付けます' })

  const sub = callerSub(req)
  if (!sub) return json(401, { error: 'ログインが必要です' })
  if (rateLimited(sub)) {
    return json(429, { error: '取得が多すぎます。少し待ってからやり直してください' })
  }

  const target = new URL(req.url).searchParams.get('url')
  if (!target) return json(400, { error: 'url が指定されていません' })

  let parsed: URL
  try {
    parsed = new URL(normalizeScheme(target.trim()))
  } catch {
    return json(400, { error: 'URL の形式が正しくありません' })
  }

  if (!(await isRegisteredFeed(req, parsed))) {
    return json(403, { error: 'このカレンダーは登録されていません' })
  }

  try {
    const upstream = await fetchWithChecks(parsed)

    if (!upstream.ok) {
      await upstream.body?.cancel()
      // 応答の中身を呼び出し元に返さない。到達できたかどうか・HTTP のステータス・
      // 失敗の理由の違いは、そのまま「この関数からどこへ届くか」を調べる道具になる。
      // 詳しい理由は関数のログにだけ残す。
      console.warn('fetch-ics: 上流が失敗しました', parsed.host, upstream.status)
      return json(502, { error: '取得できませんでした' })
    }

    const text = await readLimited(upstream)
    if (text === null) return json(413, { error: 'カレンダーが大きすぎます' })

    // カレンダー以外の中身は返さない（このエンドポイントを汎用の中継にしない）
    if (!text.includes('BEGIN:VCALENDAR')) {
      return json(415, { error: 'カレンダー（.ics）の URL ではないようです' })
    }

    return new Response(text, {
      headers: {
        ...CORS,
        'Content-Type': 'text/calendar; charset=utf-8',
        // 同じ URL を何度も取りに行かないよう、少しキャッシュさせる。
        // private にしているのは、応答が「そのボードを読める人だけのもの」だから。
        // public だと途中のキャッシュが利用者をまたいで同じ応答を配りうる。
        'Cache-Control': 'private, max-age=900',
      },
    })
  } catch (e) {
    // 宛先の検査で弾いたものだけは理由を返す（利用者が URL を直せるように）。
    if (e instanceof TargetError) return json(400, { error: e.message })
    console.warn('fetch-ics: 取得に失敗しました', parsed.host, String(e))
    return json(502, { error: '取得できませんでした' })
  }
}
