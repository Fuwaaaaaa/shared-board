import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { entriesFor, subscribeOutbox } from '../lib/outboxStore'
import type { QueueTable } from '../lib/writeQueue'

interface Row {
  id: string
}

/**
 * 送信中の楽観値を、refetch や Realtime のエコーから守るための「保留」。
 *
 * - insert: サーバーにまだ無くても、全件取り直しで消さない
 * - delete: サーバーにまだ有っても、取り直しやエコーで戻さない
 * - fields: そのフィールドだけローカル値を優先する（ドラッグ中の x/y など）
 *
 * 同じ行に複数の保留が重なることがある（ドラッグ中に色を変える等）ので回数で持つ。
 */
export type HoldKind<T> = 'insert' | 'delete' | (keyof T)[]

interface Hold {
  insert: number
  delete: number
  fields: Map<string, number>
}

/** 5 秒以上タブが隠れていたら、戻ったときに取り直す */
const HIDDEN_REFETCH_MS = 5000
/** 接続が切れている間の保険のポーリング間隔 */
const POLL_MS = 30000

function shallowEqualRow(a: object, b: object): boolean {
  const recA = a as Record<string, unknown>
  const recB = b as Record<string, unknown>
  const keysA = Object.keys(recA)
  const keysB = Object.keys(recB)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.is(recA[key], recB[key])) return false
  }
  return true
}

/**
 * ルームに属する 1 テーブルを購読する汎用フック。
 *
 * - 初回に room_id で絞って全件取得
 * - 以降は Realtime の INSERT / UPDATE / DELETE を反映
 * - 自分の操作は先に楽観的更新しておき、Realtime のエコーは id で重複排除する
 * - 再接続・タブ復帰・オンライン復帰では全件取り直す（切れていた間の変更を取りこぼすため）
 *
 * ローカル配列の「正」は rowsRef に持ち、すべての更新は commit() を通す。
 * setState だけに頼ると、非同期処理の途中で getRow() が古い行を返してしまう。
 */
export function useRealtimeTable<T extends Row>(
  table: string,
  roomId: string | null,
  enabled = true,
) {
  const [rows, setRowsState] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** false なら Realtime が切れている（ポーリングでしのいでいる） */
  const [live, setLive] = useState(true)

  const rowsRef = useRef<T[]>([])
  const holdsRef = useRef<Map<string, Hold>>(new Map())
  /** roomId が変わったり unmount したときに、遅れて届いた結果を捨てるための世代番号 */
  const generationRef = useRef(0)
  const inFlightRef = useRef<Promise<void> | null>(null)
  const pendingRef = useRef(false)
  const lastFetchedAtRef = useRef(0)

  /** ref を先に進めてから setState する。ここ以外で rows を書き換えない */
  const commit = useCallback((fn: (current: T[]) => T[]) => {
    const next = fn(rowsRef.current)
    if (next === rowsRef.current) return
    rowsRef.current = next
    setRowsState(next)
  }, [])

  // ---- 保留 ---------------------------------------------------------------

  const holdLocal = useCallback((id: string, what: HoldKind<T>) => {
    const holds = holdsRef.current
    const hold = holds.get(id) ?? { insert: 0, delete: 0, fields: new Map<string, number>() }
    if (what === 'insert') hold.insert++
    else if (what === 'delete') hold.delete++
    else for (const field of what) hold.fields.set(String(field), (hold.fields.get(String(field)) ?? 0) + 1)
    holds.set(id, hold)

    let released = false
    return () => {
      if (released) return
      released = true
      const current = holds.get(id)
      if (!current) return
      if (what === 'insert') current.insert = Math.max(0, current.insert - 1)
      else if (what === 'delete') current.delete = Math.max(0, current.delete - 1)
      else {
        for (const field of what) {
          const key = String(field)
          const count = (current.fields.get(key) ?? 0) - 1
          if (count <= 0) current.fields.delete(key)
          else current.fields.set(key, count)
        }
      }
      if (current.insert === 0 && current.delete === 0 && current.fields.size === 0) holds.delete(id)
    }
  }, [])

  /**
   * サーバーから届いた 1 行をローカルの行に重ねる。
   * delete 保留なら null（無視）、fields 保留があればそのフィールドだけローカルを残す。
   */
  const mergeServerRow = useCallback((current: T | undefined, incoming: T): T | null => {
    const hold = holdsRef.current.get(incoming.id)
    if (hold?.delete) return null
    if (!current || !hold || hold.fields.size === 0) return incoming
    const merged = { ...incoming } as Record<string, unknown>
    for (const field of hold.fields.keys()) merged[field] = (current as Record<string, unknown>)[field]
    return merged as T
  }, [])

  /** 全件取り直しの結果でローカルを置き換える。保留は尊重し、変わらない行は同じ参照を保つ */
  const replaceFromServer = useCallback(
    (current: T[], server: T[]): T[] => {
      const byId = new Map(current.map((row) => [row.id, row]))
      const seen = new Set<string>()
      const next: T[] = []
      let changed = current.length !== server.length

      for (const incoming of server) {
        seen.add(incoming.id)
        const local = byId.get(incoming.id)
        const merged = mergeServerRow(local, incoming)
        if (!merged) {
          changed = true
          continue
        }
        if (local && shallowEqualRow(local, merged)) next.push(local)
        else {
          next.push(merged)
          changed = true
        }
      }

      // 送信中でまだサーバーに無い行は残す
      for (const row of current) {
        if (seen.has(row.id)) continue
        if (holdsRef.current.get(row.id)?.insert) next.push(row)
        else changed = true
      }

      if (!changed && next.every((row, index) => row === current[index])) return current
      return next
    },
    [mergeServerRow],
  )

  // ---- サーバーからの反映 -------------------------------------------------

  const applyServerRow = useCallback(
    (row: T) => {
      if (!row?.id) return
      commit((current) => {
        const index = current.findIndex((r) => r.id === row.id)
        const merged = mergeServerRow(index === -1 ? undefined : current[index], row)
        if (!merged) return current
        if (index === -1) return [...current, merged]
        if (shallowEqualRow(current[index], merged)) return current
        const next = current.slice()
        next[index] = merged
        return next
      })
    },
    [commit, mergeServerRow],
  )

  const applyRemote = useCallback(
    (payload: RealtimePostgresChangesPayload<T>) => {
      if (payload.eventType === 'DELETE') {
        const removedId = (payload.old as Partial<Row>)?.id
        if (removedId) commit((current) => current.filter((r) => r.id !== removedId))
        return
      }
      applyServerRow(payload.new as T)
    },
    [commit, applyServerRow],
  )

  const applyRemoteRef = useRef(applyRemote)
  applyRemoteRef.current = applyRemote

  /**
   * 全件取り直し。同時に呼ばれても 1 本にまとめ、途中で来た要求は完了後に 1 回だけやり直す。
   */
  const refetch = useCallback((): Promise<void> => {
    if (!roomId || !enabled) return Promise.resolve()
    if (inFlightRef.current) {
      pendingRef.current = true
      return inFlightRef.current
    }

    const generation = generationRef.current
    const run = async () => {
      do {
        pendingRef.current = false
        const { data, error: fetchError } = await supabase
          .from(table)
          .select('*')
          .eq('room_id', roomId)
        if (generationRef.current !== generation) return
        if (fetchError) {
          setError(fetchError.message)
        } else {
          setError(null)
          const server = (data ?? []) as T[]
          commit((current) => replaceFromServer(current, server))
          lastFetchedAtRef.current = Date.now()
        }
      } while (pendingRef.current && generationRef.current === generation)
    }

    const promise = run().finally(() => {
      if (inFlightRef.current === promise) inFlightRef.current = null
    })
    inFlightRef.current = promise
    return promise
  }, [table, roomId, enabled, commit, replaceFromServer])

  /** 直近 ms ミリ秒以内に取り直していれば何もしない（online と visibility が重なるとき用） */
  const refetchIfStale = useCallback(
    (ms: number) => {
      if (Date.now() - lastFetchedAtRef.current < ms) return Promise.resolve()
      return refetch()
    },
    [refetch],
  )

  // ---- 購読 ---------------------------------------------------------------

  useEffect(() => {
    generationRef.current++
    inFlightRef.current = null
    pendingRef.current = false
    holdsRef.current = new Map()

    if (!roomId || !enabled) {
      commit(() => [])
      setLoading(false)
      return
    }

    const generation = generationRef.current
    setLoading(true)
    setError(null)
    setLive(true)

    void refetch().then(() => {
      if (generationRef.current === generation) setLoading(false)
    })

    // 2 回目以降の SUBSCRIBED は再接続。切れていた間の変更を取りこぼしているので取り直す
    // （初回は上の refetch と重なるので取り直さない）
    let subscribedCount = 0
    const channel = supabase
      .channel(`${table}:${roomId}`)
      .on<T>(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: `room_id=eq.${roomId}` },
        (payload) => applyRemoteRef.current(payload),
      )
      .subscribe((status) => {
        if (generationRef.current !== generation) return
        if (status === 'SUBSCRIBED') {
          subscribedCount++
          setLive(true)
          if (subscribedCount > 1) void refetch()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setLive(false)
        }
      })

    return () => {
      // 世代を進めるのが後片付けの仕事そのもの（購読しなおす前の
      // subscribe コールバックが遅れて届いても無視できるようにする）
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generationRef.current++
      supabase.removeChannel(channel)
    }
  }, [table, roomId, enabled, commit, refetch])

  /*
   * 送信箱にたまっている行を、ローカルに重ねておく（オーバーレイ）。
   *
   * ここが無いと、まだ送れていない行はリロードで消える。holdsRef は
   * 上の購読の効果が走るたびに作り直されるので、この効果はその「あと」に
   * 置かなければならない（React は宣言順に走らせる）。作り直されたあとに
   * もう一度 hold を取り直すのが、この効果の仕事。
   *
   * hold は参照カウント式なので、useOptimisticTable が送信中に取る一時的な
   * hold と自然に重なる。hold の中身には手を入れていない。
   */
  useEffect(() => {
    if (!roomId || !enabled) return
    const queueTable = table as QueueTable

    // 1 件につき 1 つだけ hold を持つ。解放する道も 1 本にして、取りこぼしを防ぐ
    const held = new Map<string, { release: () => void; signature: string }>()

    const reconcile = () => {
      const wanted = entriesFor(roomId, queueTable)
      const seen = new Set<string>()

      for (const entry of wanted) {
        seen.add(entry.key)
        const signature =
          entry.kind === 'update'
            ? `update:${Object.keys(entry.patch ?? {}).sort().join(',')}`
            : entry.kind

        const current = held.get(entry.key)
        if (current && current.signature === signature) continue
        current?.release()

        if (entry.kind === 'create') {
          const release = holdLocal(entry.rowId, 'insert')
          held.set(entry.key, { release, signature })
          commit((rows) =>
            rows.some((row) => row.id === entry.rowId)
              ? rows
              : [...rows, entry.row as unknown as T],
          )
        } else if (entry.kind === 'update') {
          const fields = Object.keys(entry.patch ?? {}) as (keyof T)[]
          const release = holdLocal(entry.rowId, fields)
          held.set(entry.key, { release, signature })
          commit((rows) =>
            rows.map((row) =>
              row.id === entry.rowId ? ({ ...row, ...entry.patch } as T) : row,
            ),
          )
        } else {
          const release = holdLocal(entry.rowId, 'delete')
          held.set(entry.key, { release, signature })
          commit((rows) => rows.filter((row) => row.id !== entry.rowId))
        }
      }

      // 送れた・捨てられた分の hold を外す
      for (const [key, entry] of held) {
        if (seen.has(key)) continue
        entry.release()
        held.delete(key)
      }
    }

    reconcile()
    const stop = subscribeOutbox(reconcile)
    return () => {
      stop()
      for (const entry of held.values()) entry.release()
      held.clear()
    }
    // holdLocal / commit は identity が安定している
  }, [table, roomId, enabled, holdLocal, commit])

  // タブに戻ったとき・オンラインに戻ったときは取り直す。
  // 裏にいる間は Realtime が止められることがあり、その間の変更は届かない。
  useEffect(() => {
    if (!roomId || !enabled) return
    let hiddenAt: number | null = null

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
        return
      }
      const wasHidden = hiddenAt !== null && Date.now() - hiddenAt >= HIDDEN_REFETCH_MS
      hiddenAt = null
      if (wasHidden) void refetchIfStale(2000)
    }
    const onOnline = () => {
      void refetchIfStale(2000)
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
    }
  }, [roomId, enabled, refetchIfStale])

  // Realtime が切れている間は 30 秒ごとに取り直す保険
  useEffect(() => {
    if (live || !roomId || !enabled) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refetch()
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [live, roomId, enabled, refetch])

  // ---- 楽観的更新 ---------------------------------------------------------

  /** ローカルの配列だけを差し替える（無ければ足す） */
  const upsertLocal = useCallback(
    (row: T) => {
      commit((current) => {
        const index = current.findIndex((r) => r.id === row.id)
        if (index === -1) return [...current, row]
        const next = current.slice()
        next[index] = row
        return next
      })
    },
    [commit],
  )

  const removeLocal = useCallback(
    (id: string) => {
      commit((current) => {
        if (!current.some((r) => r.id === id)) return current
        return current.filter((r) => r.id !== id)
      })
    },
    [commit],
  )

  /** 一部のフィールドだけ差し替える。戻り値は差し替える前の行（無ければ undefined） */
  const patchLocal = useCallback(
    (id: string, patch: Partial<T>): T | undefined => {
      let before: T | undefined
      commit((current) => {
        const index = current.findIndex((r) => r.id === id)
        if (index === -1) return current
        before = current[index]
        const next = current.slice()
        next[index] = { ...before, ...patch }
        return next
      })
      return before
    },
    [commit],
  )

  /** 常に最新の行を返す（非同期処理や undo のクロージャから使う） */
  const getRow = useCallback((id: string): T | undefined => {
    return rowsRef.current.find((r) => r.id === id)
  }, [])

  /** 互換用: 配列ごと差し替える */
  const setRows = useCallback(
    (next: T[]) => {
      commit(() => next)
    },
    [commit],
  )

  return useMemo(
    () => ({
      rows,
      loading,
      error,
      live,
      upsertLocal,
      removeLocal,
      patchLocal,
      getRow,
      holdLocal,
      applyServerRow,
      refetch,
      setRows,
    }),
    [
      rows,
      loading,
      error,
      live,
      upsertLocal,
      removeLocal,
      patchLocal,
      getRow,
      holdLocal,
      applyServerRow,
      refetch,
      setRows,
    ],
  )
}
