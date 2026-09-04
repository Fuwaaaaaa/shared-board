import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

interface Entry {
  url: string
  /** 発行した時刻（ms）。期限の半分を過ぎたら取り直す */
  issuedAt: number
}

/** 取り直しの見回り間隔 */
const REFRESH_TICK_MS = 60000

/**
 * 非公開バケットのファイルを表示するための署名付き URL をまとめて発行する。
 *
 * path ごとにキャッシュし、新しく増えた path の分だけ署名する。
 * 以前は path が 1 つ増えるたびに全件を署名し直していて、画像がちらついていた。
 * 期限の半分を過ぎたものだけ 60 秒ごとに取り直し、消えた path は掃除する。
 *
 * download を true にすると、Storage が Content-Disposition: attachment を付けて返す。
 * 添付ファイルには必ず付けること。<a download> はクロスオリジンの URL では
 * 仕様上むしされるため、あれだけでは「保存」にならず、Supabase のドメイン上で
 * そのまま表示されてしまう（HTML を置かれると、利用者が信頼しているドメインで
 * 任意の JS が動く）。画像はページ内に出したいので false のまま。
 */
export function useSignedUrls(bucket: string, paths: string[], expiresIn = 3600, download = false) {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const cacheRef = useRef<Map<string, Entry>>(new Map())
  const inFlightRef = useRef<Set<string>>(new Set())

  // 配列は毎回別インスタンスになるので、内容から安定したキーを作る
  const key = [...new Set(paths)].sort().join('|')

  useEffect(() => {
    const wanted = key ? key.split('|') : []
    const cache = cacheRef.current
    let cancelled = false

    // 表に出す URL の集合を作り直す。変わっていなければ同じオブジェクトを保つ
    const publish = () => {
      setUrls((current) => {
        const next: Record<string, string> = {}
        let changed = false
        for (const path of wanted) {
          const entry = cache.get(path)
          if (!entry) continue
          next[path] = entry.url
          if (current[path] !== entry.url) changed = true
        }
        if (!changed && Object.keys(current).length === Object.keys(next).length) return current
        return next
      })
    }

    const sign = async (list: string[]) => {
      const targets = list.filter((path) => !inFlightRef.current.has(path))
      if (targets.length === 0) return
      for (const path of targets) inFlightRef.current.add(path)
      try {
        const { data, error } = await supabase.storage
          .from(bucket)
          .createSignedUrls(targets, expiresIn, download ? { download: true } : undefined)
        if (cancelled || error || !data) return
        const now = Date.now()
        for (const item of data) {
          if (item.path && item.signedUrl) cache.set(item.path, { url: item.signedUrl, issuedAt: now })
        }
        publish()
      } finally {
        for (const path of targets) inFlightRef.current.delete(path)
      }
    }

    // 消えた path を掃除する
    const wantedSet = new Set(wanted)
    for (const path of [...cache.keys()]) if (!wantedSet.has(path)) cache.delete(path)

    // まだ無いものだけ署名する
    const missing = wanted.filter((path) => !cache.has(path))
    if (missing.length > 0) void sign(missing)
    publish()

    // 期限の半分を過ぎたものだけ取り直す
    const timer = window.setInterval(() => {
      const halfLife = (expiresIn * 1000) / 2
      const now = Date.now()
      const stale = wanted.filter((path) => {
        const entry = cache.get(path)
        return entry && now - entry.issuedAt >= halfLife
      })
      if (stale.length > 0) void sign(stale)
    }, REFRESH_TICK_MS)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [bucket, key, expiresIn, download])

  return urls
}
