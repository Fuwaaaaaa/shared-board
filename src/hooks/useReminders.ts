import { useEffect, useMemo, useRef, useState } from 'react'
import { addDays, format, parseISO } from 'date-fns'
import { ja } from 'date-fns/locale'
import { expandOccurrences } from '../lib/recurrence'
import { reminderKey } from '../lib/dates'
import type { CalendarEvent, EventOverride, Todo } from '../lib/types'

const NOTIFIED_KEY = 'board.notifiedReminders'
const CHECK_INTERVAL_MS = 30_000
/** これより古い予定・期限は、ページを開いた瞬間に通知しない（起動時の大量通知を防ぐ） */
const STALE_AFTER_MS = 60 * 60 * 1000
/** 通知候補を組み直す間隔。展開の窓（前後数日）がこの間隔で先へ進む */
const REBUILD_INTERVAL_MS = 10 * 60_000

export interface ReminderItem {
  /** 通知済み管理のための一意キー（send-reminders の送信済み台帳と同じ形） */
  key: string
  fireAt: Date
  title: string
  body: string
}

function loadNotified(): Set<string> {
  try {
    const raw = localStorage.getItem(NOTIFIED_KEY)
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set<string>()
  }
}

function saveNotified(keys: Set<string>) {
  try {
    // 無限に増えないよう直近 300 件だけ覚えておく
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify([...keys].slice(-300)))
  } catch {
    /* プライベートモードなどで保存できなくても致命的ではない */
  }
}

const notificationsSupported = typeof window !== 'undefined' && 'Notification' in window

/**
 * 通知を出す。
 *
 * Android の Chrome は `new Notification()` を受け付けず（Service Worker 経由でしか出せない）、
 * 例外を投げる。登録済みの Service Worker があればそちらで出し、なければ従来の方法に落とす。
 * どちらも失敗したら黙って諦める（通知は付加機能で、画面の他の機能を止める理由にはならない）。
 */
async function showNotification(item: ReminderItem) {
  const options: NotificationOptions = { body: item.body, tag: item.key, icon: '/icon-192.png' }

  try {
    const registration = await navigator.serviceWorker?.getRegistration()
    if (registration?.active) {
      await registration.showNotification(item.title, options)
      return
    }
  } catch (e) {
    console.warn('Service Worker 経由の通知に失敗しました', e)
  }

  try {
    new Notification(item.title, options)
  } catch (e) {
    console.warn('通知を出せませんでした', e)
  }
}

/**
 * 予定・TODO の事前通知をまとめて面倒みる。
 *
 * この仕組みが動くのはタブを開いている間だけ。タブを閉じているあいだは
 * usePushNotifications と supabase/functions/send-reminders が受け持つ。
 */
export function useNotifications(items: ReminderItem[]) {
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    notificationsSupported ? Notification.permission : 'denied',
  )
  const notifiedRef = useRef<Set<string>>(loadNotified())

  // タイマーからは常に最新の一覧を見たいので ref に写しておく
  const itemsRef = useRef(items)
  itemsRef.current = items

  useEffect(() => {
    if (!notificationsSupported || permission !== 'granted') return

    const check = () => {
      const now = Date.now()
      let changed = false

      for (const item of itemsRef.current) {
        if (notifiedRef.current.has(item.key)) continue

        const fireAt = item.fireAt.getTime()
        if (fireAt > now) continue
        if (now - fireAt > STALE_AFTER_MS) continue

        // 先に「済み」にしてから出す。1 件の失敗で残りが止まらないし、次の周回で二重に出ない
        notifiedRef.current.add(item.key)
        changed = true
        void showNotification(item)
      }

      if (changed) saveNotified(notifiedRef.current)
    }

    check()
    const timer = window.setInterval(check, CHECK_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [permission])

  async function requestPermission() {
    if (!notificationsSupported) return
    const result = await Notification.requestPermission()
    setPermission(result)
  }

  return { supported: notificationsSupported, permission, requestPermission }
}

/** 予定と TODO から通知予定リストを組み立てる */
export function useRoomReminders(
  events: CalendarEvent[],
  todos: Todo[],
  overrides: EventOverride[],
  roomName: string,
) {
  // 開きっぱなしのタブでも展開の窓が先へ進むよう、一定間隔で組み直す
  const now = useNow(REBUILD_INTERVAL_MS)

  const items = useMemo<ReminderItem[]>(() => {
    const list: ReminderItem[] = []

    // 予定（繰り返しを展開して、直近 3 日ぶんだけ見る）。
    // 「この回だけ削除」した回は展開結果に出てこないので、そのまま通知されない。
    const soon = expandOccurrences(events, addDays(now, -1), addDays(now, 3), overrides)
    for (const occurrence of soon) {
      const minutes = occurrence.view.remind_minutes
      if (minutes === null || minutes === undefined) continue

      list.push({
        // 実効の開始時刻で同定するので、動かした回はあらためて通知される
        key: reminderKey('event', occurrence.event.id, occurrence.start, minutes),
        fireAt: new Date(occurrence.start.getTime() - minutes * 60_000),
        title: `📅 ${occurrence.view.title}`,
        body: `${format(occurrence.start, occurrence.view.all_day ? 'M/d(E)' : 'M/d(E) HH:mm', { locale: ja })} — ${roomName}`,
      })
    }

    // TODO
    for (const todo of todos) {
      if (todo.done || !todo.due_at) continue
      const minutes = todo.remind_minutes
      if (minutes === null || minutes === undefined) continue

      const due = parseISO(todo.due_at)
      list.push({
        key: reminderKey('todo', todo.id, todo.due_at, minutes),
        fireAt: new Date(due.getTime() - minutes * 60_000),
        title: `⏰ ${todo.title}`,
        body: `期限 ${format(due, 'M/d(E) HH:mm', { locale: ja })} — ${roomName}`,
      })
    }

    return list
  }, [events, todos, overrides, roomName, now])

  return useNotifications(items)
}

/** 一定間隔で現在時刻を更新する（期限切れ表示を自動で切り替えるため） */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}
