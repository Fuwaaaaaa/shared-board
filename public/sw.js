/*
 * みんなのボード — Service Worker
 *
 *  1. プッシュ通知の受信と、通知クリック時の遷移
 *  2. アプリ本体のキャッシュ（オフラインでも起動できるようにする）
 *
 * データ（Supabase への通信）はキャッシュしない。
 * オフライン時は「最後に開いた画面の枠」までが表示され、中身は再接続後に入る。
 */

// 版を上げると、activate で古いキャッシュがまとめて捨てられる。
// v1 では失敗した応答も index.html として保存してしまっていたので、一度流す。
// v2 では、無くなったチャンクの URL に返ってきた index.html を JS として控えていたので、
// もう一度流す。
const CACHE = 'board-shell-v3'
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png']

// ---------------------------------------------------------------- ライフサイクル

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {
        /* 1 つでも取れなければ諦める。オフライン対応は付加機能なので致命的ではない */
      })
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

// ---------------------------------------------------------------- キャッシュ

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // Supabase など外部への通信はそのまま通す（キャッシュすると古いデータが出てしまう）
  if (url.origin !== self.location.origin) return

  // 画面遷移: まずネットワーク、だめならキャッシュした index.html を返す
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // 成功した応答だけを控える。
          // 500 / 502 / 503 や、公衆 Wi-Fi のログイン画面に差し替えられた応答を
          // そのまま保存すると、それが「オフラインのときに出す画面」として
          // 固定されてしまい、次にオンラインで開けるまで直らない。
          if (response.ok && response.type === 'basic') {
            const copy = response.clone()
            caches.open(CACHE).then((cache) => cache.put('/index.html', copy))
          }
          return response
        })
        .catch(() => caches.match('/index.html').then((cached) => cached ?? offlineResponse())),
    )
    return
  }

  // ビルド成果物はファイル名にハッシュが入るので、キャッシュ優先で良い。
  // 取れなかったときは、そのまま失敗させる。ここは JS / CSS / 画像なので、
  // HTML のオフライン画面を返すと構文エラーになるだけ。
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request).then((response) => {
        if (response.ok && (isBuildAsset(url, response) || SHELL.includes(url.pathname))) {
          const copy = response.clone()
          caches.open(CACHE).then((cache) => cache.put(request, copy))
        }
        return response
      })
    }),
  )
})

/*
 * /assets/ の下で、中身も本当にビルド成果物か。
 *
 * デプロイをまたいで開いていたタブは、もう無い古いチャンクを取りに行く。
 * Vercel は無いパスにも index.html を 200 で返す（vercel.json の rewrites）ので、
 * 名前だけで判断すると HTML を JS の URL で控えてしまい、キャッシュ優先のせいで
 * そのチャンクの読み込みがずっと壊れたままになる。
 */
function isBuildAsset(url, response) {
  if (!url.pathname.startsWith('/assets/')) return false
  const type = response.headers.get('Content-Type') || ''
  return !type.includes('text/html')
}

function offlineResponse() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:2rem">' +
      '<h1>オフラインです</h1><p>接続が戻ったら、もう一度開いてください。</p></body>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )
}

// ---------------------------------------------------------------- プッシュ通知

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = { title: 'みんなのボード', body: event.data ? event.data.text() : '' }
  }

  const title = payload.title || 'みんなのボード'
  const options = {
    body: payload.body || '',
    tag: payload.tag || undefined,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    renotify: Boolean(payload.tag),
    // 遷移先はこのサイトの中だけ。payload は VAPID 署名付きなので送り主は自分の
    // サーバーに限られるが、SITE_URL の設定ミスや将来の入力の混入で
    // 外部サイトへ飛ばす通知にならないよう、ここで自分のオリジンに閉じておく。
    data: { url: samePathOrRoot(payload.url) },
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

/*
 * ブラウザが購読を失効・更新したとき（Android で長く放置すると起きる）。
 * 同じ鍵で購読し直し、開いているタブに新しい購読を渡して台帳（push_subscriptions）を
 * 差し替えてもらう。タブが 1 つもなければ、次に開いたときのマウント時同期に任せる。
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  const notifyClients = (subscription) =>
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          client.postMessage({ type: 'push-resubscribed', subscription: subscription.toJSON() })
        }
      })

  const resubscribe = () => {
    if (event.newSubscription) return Promise.resolve(event.newSubscription)
    const old = event.oldSubscription
    const key = old && old.options ? old.options.applicationServerKey : null
    if (!key) return Promise.reject(new Error('no applicationServerKey'))
    return self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    })
  }

  event.waitUntil(
    resubscribe()
      .then(notifyClients)
      .catch(() => {
        /* 再購読できなければ、次に画面を開いたときに「受け取る」からやり直してもらう */
      }),
  )
})

/** 通知の遷移先を、このサイトの中のパスだけに落とす */
function samePathOrRoot(raw) {
  try {
    const url = new URL(String(raw || '/'), self.location.origin)
    if (url.origin !== self.location.origin) return '/'
    return url.pathname + url.search
  } catch {
    return '/'
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = samePathOrRoot(event.notification.data && event.notification.data.url)

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // すでに同じボードを開いているタブがあればそれを前面に出す。
      // includes だと target が '/' のときに全部のタブに当たってしまうので、
      // パスそのものを突き合わせる。
      for (const client of windowClients) {
        let path = ''
        try {
          path = new URL(client.url).pathname
        } catch {
          continue
        }
        if (path === new URL(target, self.location.origin).pathname && 'focus' in client) {
          return client.focus()
        }
      }
      return self.clients.openWindow(target)
    }),
  )
})
