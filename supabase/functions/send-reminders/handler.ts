/*
 * 予定・リマインドの通知を Web Push で送る Supabase Edge Function。
 *
 * pg_cron から 1 分おきに呼び出される想定。
 * 「通知すべき時刻を過ぎたばかりのもの」を探し、二重送信を防ぎながら送る。
 *
 * 繰り返しの展開はフロントと同じ _shared/recurrence.ts を使う。「この回だけ」の例外
 * （削除・移動・通知の変更）も展開に反映されるので、画面で見えている通りに送られる。
 *
 * デプロイ:
 *   npx supabase functions deploy send-reminders
 *   npx supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
 *   npx supabase secrets set CRON_SHARED_SECRET=...   （cron.sql が Vault に作った値と同じもの）
 *
 *   JWT を検証しない設定は supabase/config.toml に書いてあるので --no-verify-jwt は要りません。
 *   認証は CRON_SHARED_SECRET で行います（_shared/cronAuth.ts）。
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import webpush from 'npm:web-push@3.6.7'
import { expandOccurrences, type Recurrence } from '../_shared/recurrence.ts'
import { DAY_MS, reminderKey, toBoardDate } from '../_shared/dates.ts'
import { isCronCaller } from '../_shared/cronAuth.ts'
import { fetchAllPages } from '../_shared/paging.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com'
const SITE_URL = Deno.env.get('SITE_URL') ?? ''

/** 通知時刻がこの範囲に入ったものを送る（cron の間隔より少し広めにとる） */
const WINDOW_BEFORE_MS = 3 * 60 * 1000
const WINDOW_AFTER_MS = 30 * 1000

/** `.in()` に渡す id の数。URL が長くなりすぎないように分割する */
const IN_CHUNK = 200

interface EventRow {
  id: string
  room_id: string
  title: string
  description: string
  start_at: string
  end_at: string | null
  all_day: boolean
  color: string
  recurrence: Recurrence
  recurrence_days: number[]
  recurrence_week: number | null
  recurrence_interval: number | null
  recurrence_until: string | null
  remind_minutes: number | null
  tags: string[]
}

/*
 * 取ってくる列。
 *
 * ここに列を足し忘れても何もエラーにならない。ruleOf が undefined を見て
 * 従来どおりの並びに落ち、通知だけが違う曜日に飛ぶ。気づけないので、
 * EventLike の全フィールドが並んでいることをテストで押さえてある
 * （src/lib/__tests__/recurrence.test.ts）。
 */
const EVENT_COLUMNS =
  'id, room_id, title, description, start_at, end_at, all_day, color, recurrence, recurrence_days, recurrence_week, recurrence_interval, recurrence_until, remind_minutes, tags'

interface OverrideRow {
  event_id: string
  /** 例外行が持つボードの id。予定側の room_id と一致していなければ使わない */
  room_id: string
  occurrence_date: string
  canceled: boolean
  title: string | null
  description: string | null
  start_at: string | null
  end_at: string | null
  all_day: boolean | null
  color: string | null
  remind_minutes: number | null
  tags: string[] | null
}

const OVERRIDE_COLUMNS =
  'event_id, room_id, occurrence_date, canceled, title, description, start_at, end_at, all_day, color, remind_minutes, tags'

interface TodoRow {
  id: string
  room_id: string
  title: string
  due_at: string | null
  done: boolean
  assignee_id: string | null
  remind_minutes: number | null
}

interface RoomRow {
  id: string
  slug: string
  name: string
  owner_id: string
}

/** サイト内通知（@メンション・担当の指名など）。タブを閉じていても届けたい。 */
interface NotificationRow {
  id: string
  room_id: string
  user_id: string
  kind: string
  actor_name: string
  body: string
  created_at: string
}

const NOTIFICATION_ICONS: Record<string, string> = {
  mention: '💬',
  assigned: '⏰',
  converted: '🖍️',
  join_request: '🙋',
  join_decided: '👋',
  // 流量の上限を超えたぶんをまとめた行（schema.sql の tg_throttle_notifications）
  digest: '📥',
}

interface Job {
  sendKey: string
  roomId: string
  roomSlug: string
  roomName: string
  roomOwnerId: string
  title: string
  body: string
  /** 指定があればこの人にだけ送る */
  onlyUserId: string | null
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

export function chunk<T>(list: T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < list.length; i += size) result.push(list.slice(i, i + size))
  return result
}

/** 通知本文の日時。終日予定は時刻を出さない */
export function formatJst(date: Date, allDay = false): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  }
  if (!allDay) {
    options.hour = '2-digit'
    options.minute = '2-digit'
  }
  return new Intl.DateTimeFormat('ja-JP', options).format(date)
}

/**
 * 予定の id を列挙して、その例外行をまとめて取る。
 *
 * 例外行は room_id と event_id を別々に持つ。DB 側にも複合外部キーを入れて
 * 所属の食い違う行は作れないようにしたが（supabase/schema.sql の 1.7）、
 * ここは service_role で動いていて RLS を素通りする場所なので、もう一度確かめる。
 *
 * 食い違う行を通すと、他人のボードの予定の「この回だけ」を乗っ取れてしまう
 * —— canceled にして通知を止める、title / start_at を書き換えて任意の文言を
 * そのボードの参加者全員の端末に配る、といったことができる。
 *
 * 1 つでも読めなければ null を返す。欠けたまま展開すると、取り消した回・動かした回・
 * 通知を切った回が元のまま通知され、台帳に印がつくので次の実行でも直らない。
 */
async function fetchOverrides(events: EventRow[]): Promise<OverrideRow[] | null> {
  const roomByEvent = new Map(events.map((event) => [event.id, event.room_id]))
  const result: OverrideRow[] = []

  for (const ids of chunk([...roomByEvent.keys()], IN_CHUNK)) {
    // 200 件の予定でも、例外行は 1000 を超えうる（毎日の予定の「この回だけ」など）
    const { data, error } = await fetchAllPages<OverrideRow>((from, to) =>
      admin
        .from('event_overrides')
        .select(OVERRIDE_COLUMNS)
        .in('event_id', ids)
        .order('id')
        .range(from, to),
    )
    if (error) {
      console.error('event_overrides の取得に失敗。予定の通知は次の実行に回します', error.message)
      return null
    }
    for (const row of data) {
      if (row.room_id !== roomByEvent.get(row.event_id)) {
        console.warn('event_overrides: 所属の合わない例外行を無視しました', row.event_id)
        continue
      }
      result.push(row)
    }
  }
  return result
}

/**
 * 通知に使うボードだけを id で引く。
 *
 * 以前は全ボードを 1 回で読んでいたので、ボードが 1000 を超えると 1000 行の上限で
 * 切られ、そこから外れたボードの通知は黙って落ちていた（毎分、全ボードを読むのも重い）。
 * 読めなかったボードの通知は見送るだけで、印をつけないので次の実行で拾える。
 */
async function fetchRooms(ids: string[]): Promise<Map<string, RoomRow>> {
  const byId = new Map<string, RoomRow>()
  for (const part of chunk([...new Set(ids)], IN_CHUNK)) {
    const { data, error } = await admin
      .from('rooms')
      .select('id, slug, name, owner_id')
      .in('id', part)
    if (error) {
      console.error('rooms の取得に失敗', error.message)
      continue
    }
    for (const room of (data ?? []) as RoomRow[]) byId.set(room.id, room)
  }
  return byId
}

async function collectJobs(now: Date): Promise<Job[]> {
  const windowStart = new Date(now.getTime() - WINDOW_BEFORE_MS)
  const windowEnd = new Date(now.getTime() + WINDOW_AFTER_MS)

  // 予定（繰り返しは前後 2 日ぶんだけ見れば足りる。1 日前通知 + 窓のぶん）
  const expandFrom = new Date(now.getTime() - 2 * DAY_MS)
  const expandTo = new Date(now.getTime() + 2 * DAY_MS)

  // どれも全ボードぶんなので、1000 行の上限で切られないようページに分けて読む。
  // 読めなかった分は通知せずに見送るだけで、印をつけないので次の実行で拾える
  const [baseEvents, todosResult, notificationsResult, remindOverrides] = await Promise.all([
    fetchAllPages<EventRow>((from, to) =>
      admin
        .from('events')
        .select(EVENT_COLUMNS)
        .not('remind_minutes', 'is', null)
        // ゴミ箱に入れたものは通知しない
        .is('deleted_at', null)
        .order('id')
        .range(from, to),
    ),
    fetchAllPages<TodoRow>((from, to) =>
      admin
        .from('todos')
        .select('id, room_id, title, due_at, done, assignee_id, remind_minutes')
        .eq('done', false)
        .not('remind_minutes', 'is', null)
        .not('due_at', 'is', null)
        .is('deleted_at', null)
        .order('id')
        .range(from, to),
    ),
    // 未読のままのサイト内通知。開いている画面にはその場で出るので、
    // ここで拾えるのは「タブを閉じている人あて」だけになる。
    fetchAllPages<NotificationRow>((from, to) =>
      admin
        .from('notifications')
        .select('id, room_id, user_id, kind, actor_name, body, created_at')
        .eq('read', false)
        .gte('created_at', new Date(now.getTime() - WINDOW_BEFORE_MS).toISOString())
        .order('id')
        .range(from, to),
    ),
    // 元の予定は通知なしでも、「この回だけ」通知ありにした回がありうる。その予定も対象に入れる
    fetchAllPages<{ event_id: string }>((from, to) =>
      admin
        .from('event_overrides')
        .select('event_id')
        .eq('canceled', false)
        .not('remind_minutes', 'is', null)
        .gte('occurrence_date', toBoardDate(expandFrom))
        .lte('occurrence_date', toBoardDate(expandTo))
        .order('id')
        .range(from, to),
    ),
  ])
  if (baseEvents.error) console.error('events の取得に失敗', baseEvents.error.message)
  if (todosResult.error) console.error('todos の取得に失敗', todosResult.error.message)
  if (notificationsResult.error) {
    console.error('notifications の取得に失敗', notificationsResult.error.message)
  }
  if (remindOverrides.error) {
    console.error('event_overrides の取得に失敗', remindOverrides.error.message)
  }

  const events = [...baseEvents.data]
  const knownIds = new Set(events.map((e) => e.id))
  const extraIds = [
    ...new Set(remindOverrides.data.map((o) => o.event_id).filter((id) => !knownIds.has(id))),
  ]
  for (const ids of chunk(extraIds, IN_CHUNK)) {
    const { data } = await admin
      .from('events')
      .select(EVENT_COLUMNS)
      .in('id', ids)
      .is('deleted_at', null)
    events.push(...((data ?? []) as EventRow[]))
  }

  const todos = todosResult.data
  const notifications = notificationsResult.data
  const roomById = await fetchRooms([
    ...events.map((event) => event.room_id),
    ...todos.map((todo) => todo.room_id),
    ...notifications.map((notification) => notification.room_id),
  ])

  // 「この回だけ」を読めなければ、予定の通知はこの回は見送る（印をつけないので次の実行で拾える）
  const overrides = await fetchOverrides(events)
  const occurrences =
    overrides === null ? [] : expandOccurrences(events, expandFrom, expandTo, overrides)

  const jobs: Job[] = []

  for (const occ of occurrences) {
    const room = roomById.get(occ.event.room_id)
    if (!room) continue

    // 「この回だけ通知なし」は view で null になる。削除した回はそもそも展開結果に出ない
    const minutes = occ.view.remind_minutes
    if (minutes === null || minutes === undefined) continue

    const fireAt = new Date(occ.start.getTime() - minutes * 60_000)
    if (fireAt < windowStart || fireAt > windowEnd) continue

    jobs.push({
      sendKey: reminderKey('event', occ.event.id, occ.start, minutes),
      roomId: occ.event.room_id,
      roomSlug: room.slug,
      roomName: room.name,
      roomOwnerId: room.owner_id,
      title: `📅 ${occ.view.title}`,
      body: `${formatJst(occ.start, occ.view.all_day)} — ${room.name}`,
      onlyUserId: null,
    })
  }

  // リマインド
  for (const todo of todos) {
    const room = roomById.get(todo.room_id)
    if (!room || !todo.due_at || todo.remind_minutes === null) continue

    const due = new Date(todo.due_at)
    const fireAt = new Date(due.getTime() - todo.remind_minutes * 60_000)
    if (fireAt < windowStart || fireAt > windowEnd) continue

    jobs.push({
      sendKey: reminderKey('todo', todo.id, todo.due_at, todo.remind_minutes),
      roomId: todo.room_id,
      roomSlug: room.slug,
      roomName: room.name,
      roomOwnerId: room.owner_id,
      title: `⏰ ${todo.title}`,
      body: `期限 ${formatJst(due)} — ${room.name}`,
      // 担当者が決まっているならその人だけに送る
      onlyUserId: todo.assignee_id,
    })
  }

  // サイト内通知
  for (const notification of notifications) {
    const room = roomById.get(notification.room_id)
    if (!room) continue

    const icon = NOTIFICATION_ICONS[notification.kind] ?? '🔔'
    jobs.push({
      sendKey: `notification:${notification.id}`,
      roomId: notification.room_id,
      roomSlug: room.slug,
      roomName: room.name,
      roomOwnerId: room.owner_id,
      title: `${icon} ${notification.actor_name || room.name}`,
      body: `${notification.body} — ${room.name}`,
      onlyUserId: notification.user_id,
    })
  }

  return jobs
}

/**
 * 送信済み台帳に印をつける。true なら「自分が最初」で送ってよい。
 *
 * 一意制約違反（23505）は「別の実行が先に印をつけた」= 送信済みなので false。
 * それ以外のエラー（接続断など）は台帳に書けていないので、やはり送らない。
 * 送らなければ次の実行でもう一度試せるが、送ってしまうと二重になる。取りこぼしより二重送信を避ける。
 */
async function claim(sendKey: string): Promise<boolean> {
  const { error } = await admin.from('reminder_sends').insert({ send_key: sendKey })

  if (!error) return true
  if (error.code === '23505') return false
  console.error('reminder_sends に書けませんでした', sendKey, error.code, error.message)
  return false
}

/** 印を外す。送れなかった通知を、次の実行でもう一度試せるようにする */
async function release(sendKey: string): Promise<void> {
  const { error } = await admin.from('reminder_sends').delete().eq('send_key', sendKey)
  if (error) {
    console.error('reminder_sends の印を外せませんでした。この通知は送られません', sendKey, error.message)
  }
}

/**
 * 通知の宛先。そのボードの承認済みメンバーとオーナーだけに送る。
 *
 * 宛先が指定されている（担当者・サイト内通知の user_id）ときも、その人がボードの関係者で
 * なければ送らない。行の user_id を細工して他人に通知を届けることができないようにするため。
 */
async function recipientsFor(job: Job): Promise<string[]> {
  const { data, error } = await admin
    .from('room_members')
    .select('user_id')
    .eq('room_id', job.roomId)
    .eq('status', 'approved')
  if (error) {
    console.error('room_members の取得に失敗', job.roomId, error.message)
    return []
  }

  const participants = new Set<string>((data ?? []).map((row) => row.user_id as string))
  participants.add(job.roomOwnerId)

  if (job.onlyUserId) return participants.has(job.onlyUserId) ? [job.onlyUserId] : []
  return [...participants]
}

interface SubscriptionRow {
  id: string
  endpoint: string
  p256dh: string
  auth: string
}

/**
 * 宛先の人たちのプッシュの購読。読めなければ null。
 *
 * 以前は失敗を無視していたので、台帳に印がついたまま、一時的な失敗でもその通知は
 * 二度と送られなかった。読めなければ呼び出し側が印を外す（release）。宛先の id は、
 * 参加者の多いボードでは URL に詰めきれないので分けて引く。
 */
async function subscriptionsFor(userIds: string[]): Promise<SubscriptionRow[] | null> {
  const result: SubscriptionRow[] = []
  for (const ids of chunk(userIds, IN_CHUNK)) {
    const { data, error } = await admin
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .in('user_id', ids)
    if (error) {
      console.error('push_subscriptions の取得に失敗。次の実行に回します', error.message)
      return null
    }
    result.push(...((data ?? []) as SubscriptionRow[]))
  }
  return result
}

async function send(job: Job, subscriptions: SubscriptionRow[]): Promise<number> {
  if (subscriptions.length === 0) return 0

  const payload = JSON.stringify({
    title: job.title,
    body: job.body,
    // 画面内通知（useReminders）と同じキー。同じ通知が 2 経路で出ても 1 つにまとまる
    tag: job.sendKey,
    url: SITE_URL ? `${SITE_URL}/r/${job.roomSlug}` : `/r/${job.roomSlug}`,
  })

  let sent = 0
  const expired: string[] = []

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
        )
        sent++
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode
        // 404 / 410 は購読が失効している。掃除しておく。
        if (status === 404 || status === 410) {
          expired.push(sub.id)
        } else {
          // 例外の文字列には push のエンドポイント URL が入ることがある。
          // あの URL は「持っていれば誰でもその端末に通知を送れる」鍵そのものなので、
          // 関数のログにも残さない。どの購読かは id で追える。
          console.error('push failed', status, sub.id)
        }
      }
    }),
  )

  if (expired.length > 0) {
    await admin.from('push_subscriptions').delete().in('id', expired)
  }

  return sent
}

export async function handler(req: Request): Promise<Response> {
  // 合言葉を持つ呼び出し（pg_cron）だけ受け付ける
  if (!(await isCronCaller(req))) {
    return new Response('unauthorized', { status: 401 })
  }

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return new Response(
      JSON.stringify({ error: 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY が未設定です' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)

  const now = new Date()
  const jobs = await collectJobs(now)

  let sent = 0
  let skipped = 0

  for (const job of jobs) {
    // 宛先がいなければ台帳に印をつける前に見送る（印をつけると、あとから人が入っても送れない）
    const userIds = await recipientsFor(job)
    if (userIds.length === 0) {
      skipped++
      continue
    }
    if (!(await claim(job.sendKey))) {
      skipped++
      continue
    }
    // 購読を読めなければ印を外し、次の実行でやり直す。
    // 印をつける前に読まないのは、同じ通知が窓（3 分）のあいだ毎分拾われるため。
    // 前に読むと、送り済みの通知でも毎回購読を引きに行くことになる
    const subscriptions = await subscriptionsFor(userIds)
    if (subscriptions === null) {
      await release(job.sendKey)
      skipped++
      continue
    }
    sent += await send(job, subscriptions)
  }

  return new Response(JSON.stringify({ checked: jobs.length, sent, skipped }), {
    headers: { 'Content-Type': 'application/json' },
  })
}
