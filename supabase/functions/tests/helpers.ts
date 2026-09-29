/*
 * Edge Function のテストで使う小物。
 *
 * ここのテストは Supabase も外部のカレンダーも立てない。代わりに
 * globalThis.fetch と Deno.resolveDns を差し替えて、関数が「何を送り、
 * 返ってきたものをどう扱うか」だけを見る。DB と RLS そのものは
 * supabase/tests/rls.test.sql（pgTAP）の担当。
 */

/** 署名しない JWT。fetch-ics の callerSub は payload しか読まない */
export function jwt(payload: Record<string, unknown>): string {
  const b64 = (value: unknown) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.signature`
}

/** 1 時間後に切れる、ログイン済みの人の JWT */
export function authedJwt(sub = 'user-1'): string {
  return jwt({ role: 'authenticated', sub, exp: Math.floor(Date.now() / 1000) + 3600 })
}

export type FetchStub = (url: string, init?: RequestInit) => Response | Promise<Response>

/**
 * globalThis.fetch を差し替える。戻り値を呼ぶと元に戻る。
 * 呼ばれた URL は calls に順に入る。
 */
export function stubFetch(stub: FetchStub): { calls: string[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: string[] = []

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    return Promise.resolve(stub(url, init))
  }) as typeof fetch

  return { calls, restore: () => { globalThis.fetch = original } }
}

/**
 * Deno.resolveDns を差し替える。
 *
 * 差し替えないと、テスト用のホスト名は本当に引きに行って解決できず、
 * fetch-ics の validateTarget が「解決できなければ拒否」で全部落とす。
 */
export function stubDns(map: Record<string, string[]>): { restore: () => void } {
  const original = Deno.resolveDns
  const fake = (host: string, type: string) => {
    const addrs = map[host] ?? []
    const wanted = type === 'A' ? addrs.filter((a) => a.includes('.')) : addrs.filter((a) => a.includes(':'))
    if (wanted.length === 0) return Promise.reject(new Error('NXDOMAIN'))
    return Promise.resolve(wanted)
  }
  Object.defineProperty(Deno, 'resolveDns', { value: fake, configurable: true, writable: true })
  return {
    restore: () => {
      Object.defineProperty(Deno, 'resolveDns', { value: original, configurable: true, writable: true })
    },
  }
}

/**
 * 差し替えたまま、応答だけを入れ替えられるようにしたもの。
 *
 * board-ics / send-reminders / purge-storage は createClient を
 * モジュールの読み込み時に呼ぶ。supabase-js はそこで globalThis.fetch を
 * 捕まえるので、handler.ts を import したあとに差し替えても効かない。
 * import より前にこれを 1 度だけ入れ、テストごとに use() で中身を変える。
 */
export interface FetchRouter {
  /** これまでに呼ばれた URL */
  calls: string[]
  /** これから返すものを決める */
  use(stub: FetchStub): void
  /** calls を空にする */
  reset(): void
  restore(): void
}

export function installFetchRouter(): FetchRouter {
  let current: FetchStub = () => new Response('stub が未設定です', { status: 500 })
  const { calls, restore } = stubFetch((url, init) => current(url, init))
  return {
    calls,
    use: (stub) => { current = stub },
    reset: () => { calls.length = 0 },
    restore,
  }
}

/** Supabase の PostgREST が 1 回に返す行数の上限（既定の max_rows） */
export const MAX_ROWS = 1000

/**
 * 本物の PostgREST と同じく、1 回に MAX_ROWS 行までしか返さない応答。
 *
 * restJson は渡した行を全部返すので、上限で黙って切られるのを見逃す。
 * offset / limit（range）でページを切り、id=in.(…) で絞り込む。
 * それ以外の絞り込み（eq など）は見ない。
 */
export function restRows(url: string, rows: unknown[]): Response {
  const params = new URL(url).searchParams
  const ids = /^in\.\((.*)\)$/.exec(params.get('id') ?? '')?.[1]?.split(',')
  const matched = ids
    ? rows.filter((row) => ids.includes(String((row as { id?: unknown }).id)))
    : rows
  const offset = Number(params.get('offset') ?? 0)
  const limit = Math.min(Number(params.get('limit') ?? MAX_ROWS), MAX_ROWS)
  return restJson(matched.slice(offset, offset + limit))
}

/** PostgREST が返す形の応答 */
export function restJson(rows: unknown): Response {
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** テスト用の環境変数をまとめて入れる（handler.ts を import する前に呼ぶ） */
export function setFunctionEnv(extra: Record<string, string> = {}) {
  const base: Record<string, string> = {
    SUPABASE_URL: 'https://stub.supabase.test',
    SUPABASE_ANON_KEY: 'anon-key-for-tests',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
    SITE_URL: 'https://board.example.test',
    ...extra,
  }
  for (const [key, value] of Object.entries(base)) Deno.env.set(key, value)
}
