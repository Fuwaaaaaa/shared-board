import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { expandFeedEvents, isFeedTruncated, type FeedEvent } from '../lib/icsParse'
import type { CalendarFeed } from '../lib/types'
import { messageOf } from '../lib/errorMessage'

/** 取り込んだ内容をこの時間だけ使い回す。自動で読み直す間隔も同じ */
const CACHE_MS = 15 * 60 * 1000

interface CacheEntry {
  text: string
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()

/**
 * 購読先の URL を確かめて、取得に使う形（https:）にそろえる。通らないものは null。
 *
 * ここを素通りさせると、'/api/...' のような相対 URL を登録された場合に、
 * そのボードを開いた全員のブラウザから自分のサイトへリクエストが飛ぶ。
 * 中継（fetch-ics）側の宛先の検査は堅いが、その手前の入口もふさいでおく。
 */
export function normalizeFeedUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.length > 2000) return null

  let parsed: URL
  try {
    // 相対 URL はここで例外になる（第 2 引数を渡していないため）
    parsed = new URL(trimmed.replace(/^webcal:/i, 'https:'))
  } catch {
    return null
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  if (parsed.hostname === '') return null
  return parsed.href
}

/**
 * 一覧に出すときの表示。
 *
 * Google カレンダーの「非公開 URL」はクエリ部分が合言葉そのものなので、そこは隠す。
 * （このボードの参加者は REST 経由で URL 全体を読めるので、これは目に触れにくくする
 *   だけの措置。画面の注意書きでもその旨を伝えている）
 */
export function feedUrlLabel(raw: string): string {
  const normalized = normalizeFeedUrl(raw)
  if (!normalized) return raw
  const parsed = new URL(normalized)
  const path = parsed.pathname.length > 24 ? `${parsed.pathname.slice(0, 24)}…` : parsed.pathname
  return `${parsed.host}${path}${parsed.search ? '?…' : ''}`
}

/**
 * .ics の取得。
 *
 * 必ず Edge Function（fetch-ics）を経由する。
 * 多くの配信元（Google カレンダーなど）は CORS を許可していないので直接は読めないうえ、
 * ブラウザから任意の URL を取りに行かせないためでもある
 * （本番の Content-Security-Policy の connect-src も自分のサイトと Supabase だけに絞っている）。
 */
async function fetchIcsText(url: string): Promise<string> {
  const cached = cache.get(url)
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached.text

  const normalized = normalizeFeedUrl(url)
  if (!normalized) {
    throw new Error('URL の形式が正しくありません（https:// で始まる URL を入れてください）')
  }

  // invoke はクエリ文字列を渡せないので、関数の URL を直接叩く。
  // 中継は「ログイン済みの人」だけに開いているので、セッションがなければ送らない
  // （anon key を名乗って送っても弾かれるだけで、誰でも叩ける中継にはしない）。
  const base = import.meta.env.VITE_SUPABASE_URL as string
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string
  const { data: session } = await supabase.auth.getSession()
  const token = session.session?.access_token
  if (!token) throw new Error('読み込み中です。少し待ってからやり直してください')

  const proxied = await fetch(
    `${base}/functions/v1/fetch-ics?url=${encodeURIComponent(normalized)}`,
    { headers: { Authorization: `Bearer ${token}`, apikey: anon } },
  )
  if (!proxied.ok) {
    if (proxied.status === 404) {
      throw new Error(
        '中継用の関数が見つかりません。docs/SETUP.md の「外部カレンダーの取り込み」を参照してください。',
      )
    }
    const detail = await proxied.text().catch(() => '')
    throw new Error(`取得できませんでした（${proxied.status}）${detail ? `: ${detail}` : ''}`)
  }

  const text = await proxied.text()
  cache.set(url, { text, fetchedAt: Date.now() })
  return text
}

/** 有効な購読先をすべて読み込み、表示範囲の予定に展開して返す */
export function useCalendarFeeds(feeds: CalendarFeed[], from: Date, to: Date) {
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  /** 進めると読み直す。手動の「いま取り直す」と 15 分ごとの自動更新が使う */
  const [nonce, setNonce] = useState(0)
  const requestedRef = useRef<string>('')

  const enabled = useMemo(() => feeds.filter((f) => f.enabled), [feeds])
  const key = enabled.map((f) => `${f.id}:${f.url}`).join('|')

  // 読み込み中に feeds の配列だけ差し替わっても（内容は同じ）取り直しを打ち切らないよう、
  // effect は key と nonce だけを見て、購読先の一覧は ref から読む
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  useEffect(() => {
    if (!key) {
      setTexts({})
      setErrors({})
      return
    }
    const requestKey = `${nonce}#${key}`
    if (requestedRef.current === requestKey) return
    requestedRef.current = requestKey

    let cancelled = false
    setLoading(true)

    Promise.all(
      enabledRef.current.map(async (feed) => {
        try {
          const text = await fetchIcsText(feed.url)
          return { id: feed.id, text, error: null as string | null }
        } catch (e) {
          return { id: feed.id, text: '', error: messageOf(e) }
        }
      }),
    ).then((results) => {
      if (cancelled) return
      const nextTexts: Record<string, string> = {}
      const nextErrors: Record<string, string> = {}
      for (const result of results) {
        if (result.error) nextErrors[result.id] = result.error
        else nextTexts[result.id] = result.text
      }
      setTexts(nextTexts)
      setErrors(nextErrors)
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [key, nonce])

  /** キャッシュを捨てて取り直す。古い表示は新しい内容が届くまで残す */
  const refresh = useCallback(() => {
    for (const feed of enabledRef.current) cache.delete(feed.url)
    setNonce((n) => n + 1)
  }, [])

  // 15 分ごとに自動で読み直す（FeedSettingsModal の案内文と揃えている）
  useEffect(() => {
    if (!key) return
    const timer = window.setInterval(refresh, CACHE_MS)
    return () => window.clearInterval(timer)
  }, [key, refresh])

  const [events, truncatedIds] = useMemo<[FeedEvent[], string[]]>(() => {
    const result: FeedEvent[] = []
    const truncated: string[] = []
    for (const feed of enabled) {
      const text = texts[feed.id]
      if (!text) continue
      const expanded = expandFeedEvents(
        text,
        { id: feed.id, name: feed.name, color: feed.color },
        from,
        to,
      )
      // 展開の上限に達したら、黙って切り捨てずに設定画面で知らせる
      if (isFeedTruncated(expanded)) truncated.push(feed.id)
      result.push(...expanded)
    }
    return [result, truncated]
  }, [enabled, texts, from, to])

  // 取得の失敗と同じ場所（購読先ごとの一行）に出す
  const shownErrors = useMemo(() => {
    if (truncatedIds.length === 0) return errors
    const next = { ...errors }
    for (const id of truncatedIds) {
      next[id] ??= '予定が多すぎるため、一部だけ表示しています。'
    }
    return next
  }, [errors, truncatedIds])

  return { events, errors: shownErrors, loading, refresh }
}
