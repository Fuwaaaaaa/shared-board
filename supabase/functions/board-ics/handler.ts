/*
 * ボードのカレンダーを、読み取り専用の .ics として配る Supabase Edge Function。
 *
 * 「外部カレンダーの購読」（fetch-ics）の逆向き。Google カレンダーや Apple カレンダーの
 * 「URL で追加」に貼ると、あとから足した予定も追いかけてくれる。
 *
 * デプロイ:
 *   npx supabase functions deploy board-ics
 *   （JWT を検証しない設定は supabase/config.toml に書いてあるので、
 *     --no-verify-jwt は要りません）
 *
 * 認証:
 *   カレンダーアプリは Authorization ヘッダを付けられないので、エッジでの JWT 検証は
 *   外すしかない。代わりに URL に埋めた 32 桁（128bit）のトークンだけで照合する。
 *   トークンは room_secrets.calendar_token にあり、オーナーが
 *   rotate_calendar_token / clear_calendar_token で発行・作り直し・停止できる。
 *
 * 防御:
 *   1. GET / HEAD 以外は 405。CORS ヘッダは付けない（相手はブラウザではない）
 *   2. トークンは 32 桁の 16 進数のみ。形が違えば、未知のトークンと同じ経路へ
 *   3. isolate ローカルの速度制限（トークン別・発信元別）。あくまで速度制限で、
 *      本当の防御はトークンの長さ
 *   4. 未知のトークン・消えたボード・内部の失敗は、すべてバイト単位で同じ 404。
 *      401 と 403 を作り分けない（ボードの有無を漏らさないため）
 *   5. service_role は RLS を素通りするので、取得はすべて room_id で絞り、
 *      例外行は「取ってきた予定に属するか」をアプリ側で確かめ直す
 *      （send-reminders と同じ。schema.sql の 1.7 が文書化しているバグの形）
 *   6. DTSTAMP を固定して ETag を成立させる。毎回変えると取りに来るたび全文を送る
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import { buildIcs, type IcsEventLike, type IcsTodoLike } from '../_shared/ics.ts'
import type { OverrideLike } from '../_shared/recurrence.ts'
import { toBoardDate } from '../_shared/dates.ts'
import { fetchAllPages } from '../_shared/paging.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

/*
 * 1 ボードあたりの取得上限。
 *
 * schema.sql の tg_limit_rows_per_room が同じ数で止めているので、
 * まっとうなボードがここで切られることはない。
 */
const MAX_EVENTS = 3000
const MAX_OVERRIDES = 5000
const MAX_TODOS = 3000

/** 1 時間あたりの取得回数。カレンダーアプリの取りに来る間隔は 15 分〜1 日 */
const RATE_LIMIT_PER_HOUR = 60

/*
 * 速度制限。isolate ごとの Map なので、立ち上がり直しで消えるし
 * インスタンスをまたいでは効かない。あくまで速度制限であって、
 * 総当たりに耐えているのはトークンの長さのほう。
 */
const hits = new Map<string, { hour: number; count: number }>()

function rateLimited(key: string): boolean {
  const hour = Math.floor(Date.now() / 3_600_000)
  const entry = hits.get(key)

  if (!entry || entry.hour !== hour) {
    if (hits.size > 5_000) {
      for (const [k, v] of hits) if (v.hour !== hour) hits.delete(k)
    }
    hits.set(key, { hour, count: 1 })
    return false
  }

  entry.count++
  return entry.count > RATE_LIMIT_PER_HOUR
}

/** テスト用。isolate に溜めた回数を捨てる（本番の経路からは呼ばれない） */
export function resetRateLimits(): void {
  hits.clear()
}

/** 何を断るときも、まったく同じ応答を返す */
function notFound(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex',
    },
  })
}

/**
 * URL からトークンを取り出す。
 * 正は /functions/v1/board-ics/<token>.ics。?token= も受ける。
 * Apple カレンダーは .ics で終わる URL を好むので、拡張子つきを正にしている。
 */
export function tokenOf(url: URL): string | null {
  const last = url.pathname.split('/').pop() ?? ''
  const fromPath = last.endsWith('.ics') ? last.slice(0, -4) : last
  const candidate = /^[0-9a-f]{32}$/.test(fromPath)
    ? fromPath
    : (url.searchParams.get('token') ?? '')
  return /^[0-9a-f]{32}$/.test(candidate) ? candidate : null
}

/**
 * ファイル名に使えない文字を落とし、60 文字までにする。
 *
 * 数えるのは UTF-16 の単位ではなく文字（コードポイント）。slice で切ると絵文字の
 * 片割れが残り、encodeURIComponent が URIError を投げて購読 URL が 404 になる。
 */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\r\n]/g, '_').trim()
  return Array.from(cleaned).slice(0, 60).join('') || 'board'
}

/**
 * Content-Disposition の 1 行を組み立てる。
 *
 * ヘッダの値に入れられるのは Latin-1 まで。「みんなのボード」のような名前を
 * そのまま入れると Response の構築がその場で例外になり、下の catch が拾って
 * 「知らないトークン」と同じ 404 になる —— つまり日本語名のボードでは
 * 購読 URL が黙って全部 404 を返していた。断り方を 1 つに揃えてあるせいで、
 * 外からは「トークンが違う」と見分けがつかない形で壊れる。
 *
 * 直し方は RFC 6266 の filename*。filename= には ASCII だけの控えも残す
 * （filename* を読めない相手のための保険。両方あるときは filename* が優先される）。
 */
export function contentDisposition(name: string): string {
  const safe = safeFileName(name)

  // ASCII に落とせない文字は _ にする。全部 _ になったら board にする
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/^_+$/, '') || 'board'

  // encodeURIComponent が残す ' ( ) ! * も、RFC 5987 の attr-char には無いので落とす
  const encoded = encodeURIComponent(`${safe}.ics`).replace(
    /['()!*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )

  return `inline; filename="${ascii}.ics"; filename*=UTF-8''${encoded}`
}

async function etagOf(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  const hex = [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `"${hex}"`
}

/**
 * DTSTAMP に入れる時刻。
 *
 * 中身が変わっていない限り同じ値を返す必要がある（毎回 now を入れると
 * 本文が毎回変わり、ETag が永久に一致せず、取りに来るたび全文を送ることになる）。
 * 一方で、終わりの無い繰り返しの RDATE は「今」から 3 年ぶんを書くので、
 * まったく止めてしまうと地平が動かない。そこで
 * 「中身の最終更新」と「今日の 0:00（JST）」の遅いほうにする。
 * 最悪でも 1 日 1 回の再取得で済む。
 */
export function stampFor(times: (string | null | undefined)[], now: Date): Date {
  const todayStart = new Date(`${toBoardDate(now)}T00:00:00+09:00`)
  let latest = todayStart.getTime()
  for (const value of times) {
    if (!value) continue
    const at = new Date(value).getTime()
    if (Number.isFinite(at) && at > latest) latest = at
  }
  return new Date(latest)
}

export async function handler(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
  }

  const url = new URL(request.url)
  const token = tokenOf(url)
  // 形が違うものも、未知のトークンとまったく同じ経路へ
  if (!token) return notFound()

  const from = request.headers.get('x-forwarded-for') ?? 'unknown'
  if (rateLimited(`t:${token}`) || rateLimited(`i:${from}`)) {
    return new Response('Too Many Requests', {
      status: 429,
      headers: { 'Retry-After': '600', 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  try {
    const { data: secret, error: secretError } = await admin
      .from('room_secrets')
      .select('room_id')
      .eq('calendar_token', token)
      .maybeSingle()
    if (secretError || !secret) return notFound()

    const roomId = secret.room_id as string

    // 終了したボードも配る。終了は「読めるが書けない」であって、消えたわけではない
    const { data: room, error: roomError } = await admin
      .from('rooms')
      .select('name')
      .eq('id', roomId)
      .maybeSingle()
    if (roomError || !room) return notFound()

    /*
     * ここから下は service_role なので RLS が効かない。
     * 取得は必ず room_id で絞り、他のボードの行が混ざる余地を作らない。
     */
    // 1 回に返るのは 1000 行まで（PostgREST の上限）。.limit を大きくしても超えられないので、
    // ページに分けて MAX_* まで読む
    const [eventsResult, overridesResult, todosResult] = await Promise.all([
      fetchAllPages<IcsEventLike & { updated_at: string }>((from, to) =>
        admin
          .from('events')
          /*
           * 列を足し忘れても何もエラーにならない。ruleOf が undefined を見て
           * 従来どおりの並びに落ち、購読 URL 経由でだけ違う日に出る。
           * IcsEventLike の全フィールドが並んでいることを
           * src/lib/__tests__/ics.test.ts で押さえてある。
           */
          .select(
            'id, title, description, start_at, end_at, all_day, kind, recurrence, recurrence_days, recurrence_week, recurrence_interval, recurrence_until, tags, updated_at',
          )
          .eq('room_id', roomId)
          .is('deleted_at', null)
          .order('id')
          .range(from, to),
        MAX_EVENTS,
      ),
      fetchAllPages<OverrideLike & { created_at: string }>((from, to) =>
        admin
          .from('event_overrides')
          .select(
            'event_id, occurrence_date, canceled, title, description, start_at, end_at, all_day, color, remind_minutes, tags, created_at',
          )
          .eq('room_id', roomId)
          .order('id')
          .range(from, to),
        MAX_OVERRIDES,
      ),
      fetchAllPages<IcsTodoLike & { created_at: string }>((from, to) =>
        admin
          .from('todos')
          .select('id, title, notes, due_at, done, created_at')
          .eq('room_id', roomId)
          .is('deleted_at', null)
          .not('due_at', 'is', null)
          .order('id')
          .range(from, to),
        MAX_TODOS,
      ),
    ])

    if (eventsResult.error || overridesResult.error || todosResult.error) return notFound()

    const events = eventsResult.data
    const todos = todosResult.data

    // 例外行は「取ってきた予定に属するか」を確かめ直す。
    // room_id で絞っているので混ざらないはずだが、確かめる側を 1 つに保つ
    const eventIds = new Set(events.map((event) => event.id))
    const overrides = overridesResult.data.filter((override) => eventIds.has(override.event_id))

    const stamp = stampFor(
      [
        ...events.map((event) => event.updated_at),
        ...overrides.map((override) => override.created_at),
        ...todos.map((todo) => todo.created_at),
      ],
      new Date(),
    )

    const body = buildIcs(room.name as string, events, todos, overrides, stamp)
    const etag = await etagOf(body)

    const headers: Record<string, string> = {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': contentDisposition(room.name as string),
      // fetch-ics と同じ。中継やブラウザに共有キャッシュとして持たせない
      'Cache-Control': 'private, max-age=900',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex',
    }

    if (request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers })
    }

    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers })
  } catch (e) {
    // 中で何が起きたかは外に出さない。理由を返すとボードの有無が漏れる
    console.error('board-ics で失敗しました', e instanceof Error ? e.message : String(e))
    return notFound()
  }
}
