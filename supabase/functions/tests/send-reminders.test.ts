/*
 * send-reminders（予定・やること・サイト内通知を Web Push で送る）。
 *
 * 毎分 pg_cron から呼ばれる。見るのは次の 5 つ。
 *   1. 合言葉なしでは何もしないこと
 *   2. VAPID が無いまま黙って動かないこと
 *   3. 二重に送らないこと（台帳に印をつけられなければ送らない）
 *   4. 宛先がいないときに、印だけ先につけてしまわないこと
 *      （つけると、あとから人が入っても永久に送られない）
 *   5. 読めなかったものがあるときに、印をつけてしまわないこと
 *      （つけると、欠けたまま送った通知も、送れなかった通知も、次の実行で直らない）
 *
 * push_subscriptions は常に空を返す。web-push は fetch ではなく node の https を
 * 使うので、ここで差し替えられない。購読が 0 件なら send() が呼ばれる前に返る。
 */

import { assert, assertEquals } from 'jsr:@std/assert@1'
import { installFetchRouter, restJson, restRows, setFunctionEnv } from './helpers.ts'

setFunctionEnv()
Deno.env.set('CRON_SHARED_SECRET', 'reminder-secret')
const net = installFetchRouter()

// VAPID を入れる前の姿を 1 つだけ確保しておく（query を変えると別のモジュールとして読まれる）
const withoutVapid = await import('../send-reminders/handler.ts?no-vapid')

const webpush = (await import('npm:web-push@3.6.7')).default
const keys = webpush.generateVAPIDKeys()
Deno.env.set('VAPID_PUBLIC_KEY', keys.publicKey)
Deno.env.set('VAPID_PRIVATE_KEY', keys.privateKey)
Deno.env.set('VAPID_SUBJECT', 'mailto:test@example.test')

const { handler, formatJst, chunk } = await import('../send-reminders/handler.ts')

const ROOM_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const EVENT_ID = '11111111-2222-3333-4444-555555555555'
const OWNER = '99999999-9999-9999-9999-999999999999'

const ROOM = { id: ROOM_ID, slug: 'board-1', name: '定例ボード', owner_id: OWNER }

/** いまから minutes 分後に始まり、その分だけ前に通知する予定（＝いま送るべき予定） */
function dueNow(minutes = 10) {
  return {
    id: EVENT_ID,
    room_id: ROOM_ID,
    title: '週次ミーティング',
    description: '',
    start_at: new Date(Date.now() + minutes * 60_000).toISOString(),
    end_at: null,
    all_day: false,
    color: 'blue',
    recurrence: 'none',
    recurrence_days: [],
    recurrence_week: null,
    recurrence_interval: null,
    recurrence_until: null,
    remind_minutes: minutes,
    tags: [],
  }
}

interface Routes {
  rooms?: unknown[]
  events?: unknown[]
  todos?: unknown[]
  notifications?: unknown[]
  overrides?: unknown[]
  members?: unknown[]
  /** reminder_sends への insert を「すでに誰かが送った」にする */
  alreadySent?: boolean
  /** 予定ごとの「この回だけ」の取得を失敗させる */
  overridesFail?: boolean
  /** プッシュの購読の取得を失敗させる */
  subscriptionsFail?: boolean
}

const failure = () =>
  new Response(JSON.stringify({ message: 'upstream timeout' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  })

function routes(r: Routes = {}) {
  net.reset()
  net.use((url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()

    if (url.includes('/rest/v1/reminder_sends')) {
      if (r.alreadySent) {
        return new Response(JSON.stringify({ code: '23505', message: 'duplicate key' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(null, { status: 201 })
    }
    if (url.includes('/rest/v1/rooms')) return restRows(url, r.rooms ?? [ROOM])
    if (url.includes('/rest/v1/event_overrides')) {
      // 予定ごとに引くほう（event_id=in.）だけを落とす
      if (r.overridesFail && url.includes('event_id=in.')) return failure()
      return restRows(url, r.overrides ?? [])
    }
    if (url.includes('/rest/v1/events')) return restRows(url, r.events ?? [])
    if (url.includes('/rest/v1/todos')) return restRows(url, r.todos ?? [])
    if (url.includes('/rest/v1/notifications')) return restRows(url, r.notifications ?? [])
    if (url.includes('/rest/v1/room_members')) {
      return restRows(url, r.members ?? [{ user_id: OWNER }])
    }
    if (url.includes('/rest/v1/push_subscriptions')) {
      return r.subscriptionsFail ? failure() : restJson([])
    }
    return new Response('想定していない問い合わせ: ' + url + ' (' + method + ')', { status: 500 })
  })
}

function call(secret: string | null = 'reminder-secret'): Request {
  const headers = new Headers()
  if (secret !== null) headers.set('x-cron-secret', secret)
  return new Request('https://fn.example.test/send-reminders', { method: 'POST', headers })
}

// ---------------------------------------------------------------------------
//  小物
// ---------------------------------------------------------------------------

Deno.test('日時は JST で組み立てる', () => {
  const at = new Date('2026-09-14T01:00:00.000Z') // JST 10:00（月）
  assertEquals(formatJst(at), '9/14(月) 10:00')
  // 終日の予定は時刻を出さない
  assertEquals(formatJst(at, true), '9/14(月)')
})

Deno.test('id をまとめて渡す単位に切る', () => {
  assertEquals(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  assertEquals(chunk([], 2), [])
  assertEquals(chunk([1], 5), [[1]])
})

// ---------------------------------------------------------------------------
//  入口
// ---------------------------------------------------------------------------

Deno.test('合言葉がなければ 401（DB にも触らない）', async () => {
  routes({ events: [dueNow()] })
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

/*
 * VAPID が無いまま 200 を返すと、cron は毎分成功したことになり、
 * 誰にも届いていないことに気づけない。
 */
Deno.test('VAPID が無ければ 500 で止まる', async () => {
  routes({ events: [dueNow()] })
  const res = await withoutVapid.handler(call())
  assertEquals(res.status, 500)
  assert((await res.text()).includes('VAPID'))
  // 合言葉は通っているが、DB は見に行かずに止まる
  assertEquals(net.calls.length, 0)
})

// ---------------------------------------------------------------------------
//  送る／送らない
// ---------------------------------------------------------------------------

Deno.test('通知すべき予定がなければ、何もしない', async () => {
  routes()
  const res = await handler(call())
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { checked: 0, sent: 0, skipped: 0 })
})

Deno.test('通知の時刻になった予定を拾う', async () => {
  routes({ events: [dueNow()] })
  const body = await (await handler(call())).json()
  assertEquals(body.checked, 1)
  // 購読が 0 件なので sent は 0。ここで見たいのは「拾って、印をつけた」こと
  assertEquals(body.skipped, 0)
  assert(net.calls.some((u) => u.includes('/rest/v1/reminder_sends')))
})

Deno.test('まだ先の予定は拾わない', async () => {
  routes({ events: [{ ...dueNow(), remind_minutes: 1 }] })
  const body = await (await handler(call())).json()
  assertEquals(body.checked, 0)
})

/* 別の実行が先に印をつけていたら、送らない */
Deno.test('二重には送らない', async () => {
  routes({ events: [dueNow()], alreadySent: true })
  const body = await (await handler(call())).json()
  assertEquals(body.checked, 1)
  assertEquals(body.skipped, 1)
  assertEquals(body.sent, 0)
})

/*
 * 担当者がそのボードの人でなければ送らない。
 * このとき reminder_sends に印をつけてしまうと、あとから本人が参加しても
 * 「送信済み」と見なされて永久に届かない。
 */
Deno.test('宛先がいないときは、台帳に印をつけない', async () => {
  const todo = {
    id: '22222222-3333-4444-5555-666666666666',
    room_id: ROOM_ID,
    title: '資料をまとめる',
    due_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    done: false,
    assignee_id: '77777777-7777-7777-7777-777777777777', // 参加者ではない人
    remind_minutes: 10,
  }
  routes({ todos: [todo], members: [] })
  const body = await (await handler(call())).json()
  assertEquals(body.checked, 1)
  assertEquals(body.skipped, 1)
  assertEquals(net.calls.some((u) => u.includes('/rest/v1/reminder_sends')), false)
})

Deno.test('知らないボードの行は無視する', async () => {
  routes({ events: [{ ...dueNow(), room_id: '00000000-0000-0000-0000-000000000000' }] })
  const body = await (await handler(call())).json()
  assertEquals(body.checked, 0)
})

/*
 * service_role は RLS を素通りするので、例外行の room_id が予定側と
 * 食い違っていないかを関数の中で確かめ直している。ここを抜くと、
 * 他人のボードの「この回だけ」を書き換えて任意の文言を配れてしまう。
 */
Deno.test('所属の合わない例外行は使わない', async () => {
  const event = { ...dueNow(), recurrence: 'daily' }
  const stray = {
    event_id: EVENT_ID,
    room_id: '00000000-0000-0000-0000-000000000000',
    occurrence_date: new Date().toISOString().slice(0, 10),
    canceled: true,
    title: null,
    description: null,
    start_at: null,
    end_at: null,
    all_day: null,
    color: null,
    remind_minutes: null,
    tags: null,
  }
  routes({ events: [event], overrides: [stray] })
  const body = await (await handler(call())).json()
  // canceled にされていれば checked は 0 になる。無視できていれば拾える
  assertEquals(body.checked, 1)
})

/*
 * 「この回だけ」を読めないまま展開すると、取り消した回・動かした回・通知を切った回が
 * 元のまま通知される。しかも台帳に印をつけるので、次の実行でも直らない。
 * 読めなかったら予定の通知はこの回は見送り、次の実行（1 分後）でやり直す。
 */
Deno.test('「この回だけ」を読めなかったら、予定の通知は送らずに次の実行へ回す', async () => {
  routes({ events: [{ ...dueNow(), recurrence: 'daily' }], overridesFail: true })
  const body = await (await handler(call())).json()
  assertEquals(body.checked, 0)
  assertEquals(net.calls.some((u) => u.includes('/rest/v1/reminder_sends')), false)
})

/*
 * 購読の取得に失敗しても印をつけたままにしていたので、その通知は失われていた
 * （次の実行では「送信済み」と見なされる）。読めなければ印を外す。
 */
Deno.test('購読を読めなかったら、台帳の印を外して次の実行へ回す', async () => {
  routes({ events: [dueNow()], subscriptionsFail: true })
  const body = await (await handler(call())).json()
  assertEquals(body.checked, 1)
  assertEquals(body.skipped, 1)
  const removed = net.calls.filter((u) => u.includes('/rest/v1/reminder_sends?send_key=eq.'))
  assertEquals(removed.length, 1)
})

/*
 * 同じ通知は窓（3 分）のあいだ毎分拾われる。送り済みかどうかは印で分かるので、
 * 送り済みの通知のために購読まで引きに行かない（ジョブごとの問い合わせを増やさない）。
 */
Deno.test('送り済みの通知では、購読を引きに行かない', async () => {
  routes({ events: [dueNow()], alreadySent: true })
  await (await handler(call())).json()
  assertEquals(net.calls.some((u) => u.includes('/rest/v1/push_subscriptions')), false)
})

/* 参加者の多いボードでは、宛先の id を URL に詰めきれない */
Deno.test('購読は宛先を分けて引く', async () => {
  const members = Array.from({ length: 450 }, (_, i) => ({
    user_id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
  }))
  routes({ events: [dueNow()], members })
  await (await handler(call())).json()
  const queries = net.calls.filter((u) => u.includes('/rest/v1/push_subscriptions'))
  assertEquals(queries.length, 3)
})

/*
 * PostgREST は 1 回に 1000 行までしか返さない（Supabase の既定の max_rows）。
 * 全ボードぶんを 1 回で読んでいたので、通知のある予定や、ボードそのものが
 * 1000 を超えると、残りの通知は黙って落ちていた。
 */
Deno.test('通知のある予定が 1000 件を超えても、全部拾う', async () => {
  const events = Array.from({ length: 1200 }, (_, i) => ({
    ...dueNow(),
    id: `11111111-2222-3333-4444-${String(i).padStart(12, '0')}`,
  }))
  routes({ events })
  const body = await (await handler(call())).json()
  assertEquals(body.checked, 1200)
})

Deno.test('ボードが 1000 を超えていても、通知するボードを引ける', async () => {
  const rooms = Array.from({ length: 1100 }, (_, i) => ({
    id: `aaaaaaaa-0000-0000-0000-${String(i).padStart(12, '0')}`,
    slug: `board-${i}`,
    name: `ボード ${i}`,
    owner_id: OWNER,
  }))
  const last = rooms[rooms.length - 1]
  routes({ rooms, events: [{ ...dueNow(), room_id: last.id }] })
  const body = await (await handler(call())).json()
  assertEquals(body.checked, 1)
})

/* ゴミ箱に入れた予定を通知しないのは、問い合わせ側の絞り込みで効かせている */
Deno.test('ゴミ箱の行は取ってこない', async () => {
  routes({ events: [dueNow()] })
  await (await handler(call())).json()

  const events = net.calls.find((u) => u.includes('/rest/v1/events?'))!
  assert(events.includes('deleted_at=is.null'), events)
  assert(events.includes('remind_minutes=not.is.null'), events)

  const todos = net.calls.find((u) => u.includes('/rest/v1/todos?'))!
  assert(todos.includes('deleted_at=is.null'), todos)
  assert(todos.includes('done=eq.false'), todos)
})
