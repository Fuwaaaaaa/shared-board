import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useIdentity } from '../lib/identity'
import { messageOf } from '../lib/errorMessage'

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined

export type PushState =
  | 'unsupported'
  | 'not-configured'
  /** iPhone / iPad の Safari。ホーム画面に追加したアイコンから開けば使える */
  | 'ios-needs-install'
  | 'off'
  | 'on'
  | 'denied'
  | 'working'

/** base64url の VAPID 公開鍵を、購読 API が受け取れる形に変換する */
function urlBase64ToBuffer(base64: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(normalized)

  const buffer = new ArrayBuffer(raw.length)
  const view = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i)
  return buffer
}

function arrayBufferToBase64(buffer: ArrayBuffer | null): string {
  if (!buffer) return ''
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return window.btoa(binary)
}

const supported =
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window

/** iPhone / iPad（iPadOS は Mac を名乗るので、タッチ対応で見分ける） */
function isIos(): boolean {
  if (typeof navigator === 'undefined') return false
  return (
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

/** ホーム画面に追加したアイコンから開いているか */
function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const legacy = (navigator as Navigator & { standalone?: boolean }).standalone === true
  return legacy || window.matchMedia?.('(display-mode: standalone)').matches === true
}

/** 購読の中身（PushSubscription.toJSON() と同じ形） */
interface SubscriptionJson {
  endpoint?: string
  keys?: { p256dh?: string; auth?: string }
}

function initialState(): PushState {
  if (!VAPID_PUBLIC_KEY) return 'not-configured'
  if (!supported) return isIos() && !isStandalone() ? 'ios-needs-install' : 'unsupported'
  return Notification.permission === 'denied' ? 'denied' : 'off'
}

/**
 * タブを閉じていても届くプッシュ通知の購読管理。
 *
 * 送信そのものは Supabase Edge Function（supabase/functions/send-reminders）が行う。
 * ここでは「このブラウザを送信先として登録／解除する」だけを扱う。
 */
export function usePushNotifications() {
  const { userId, displayName } = useIdentity()
  const [state, setState] = useState<PushState>(initialState)
  const [error, setError] = useState<string | null>(null)

  // マウント時の同期や Service Worker からの通知でも最新の名前を使えるよう ref に写す
  const identityRef = useRef({ userId, displayName })
  identityRef.current = { userId, displayName }

  /** 購読を送信先の台帳（push_subscriptions）に書く。endpoint が同じなら上書き */
  const saveSubscription = useCallback(
    async (subscription: PushSubscription | SubscriptionJson) => {
      const json: SubscriptionJson =
        'toJSON' in subscription ? (subscription.toJSON() as SubscriptionJson) : subscription
      const live = 'getKey' in subscription ? subscription : null

      const endpoint = json.endpoint ?? live?.endpoint
      if (!endpoint) throw new Error('購読の情報が読めませんでした')

      const { error: saveError } = await supabase.from('push_subscriptions').upsert(
        {
          user_id: identityRef.current.userId,
          endpoint,
          p256dh: json.keys?.p256dh ?? arrayBufferToBase64(live?.getKey('p256dh') ?? null),
          auth: json.keys?.auth ?? arrayBufferToBase64(live?.getKey('auth') ?? null),
          display_name: identityRef.current.displayName,
        },
        { onConflict: 'endpoint' },
      )
      if (saveError) throw saveError
    },
    [],
  )

  // 既に購読済みかどうかを確認する。見つかれば台帳にも書き直しておく
  // （ブラウザ側の購読は残っているのに、台帳の行だけ消えている・古いことがある）。
  useEffect(() => {
    if (!supported || !VAPID_PUBLIC_KEY) return
    let cancelled = false

    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => registration.pushManager.getSubscription())
      .then(async (subscription) => {
        if (cancelled) return
        if (subscription) {
          setState('on')
          await saveSubscription(subscription).catch(() => {
            /* 台帳に書けなくても、次に開いたときにまた試す */
          })
        } else if (Notification.permission === 'denied') {
          setState('denied')
        }
      })
      .catch(() => {
        /* 登録に失敗しても、画面の他の機能には影響させない */
      })

    return () => {
      cancelled = true
    }
  }, [saveSubscription])

  // ブラウザが購読を更新した（pushsubscriptionchange）ときは、Service Worker が
  // 再購読して新しい購読を送ってくるので、台帳を差し替える。
  useEffect(() => {
    if (!supported) return

    const handleMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; subscription?: SubscriptionJson } | null
      if (data?.type !== 'push-resubscribed' || !data.subscription) return
      void saveSubscription(data.subscription).catch(() => {
        /* 次に開いたときのマウント時同期で拾い直す */
      })
    }

    navigator.serviceWorker.addEventListener('message', handleMessage)
    return () => navigator.serviceWorker.removeEventListener('message', handleMessage)
  }, [saveSubscription])

  const enable = useCallback(async () => {
    if (!supported || !VAPID_PUBLIC_KEY) return
    setState('working')
    setError(null)

    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'off')
        return
      }

      const registration = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready

      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToBuffer(VAPID_PUBLIC_KEY),
        }))

      await saveSubscription(subscription)
      setState('on')
    } catch (e) {
      setError(messageOf(e))
      setState('off')
    }
  }, [saveSubscription])

  const disable = useCallback(async () => {
    if (!supported) return
    setState('working')

    try {
      const registration = await navigator.serviceWorker.getRegistration('/sw.js')
      const subscription = await registration?.pushManager.getSubscription()

      if (subscription) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', subscription.endpoint)
        await subscription.unsubscribe()
      }
      setState('off')
    } catch (e) {
      setError(messageOf(e))
      setState('on')
    }
  }, [])

  return { state, error, enable, disable }
}
